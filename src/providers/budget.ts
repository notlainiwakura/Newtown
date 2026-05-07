/**
 * Token budget — prevents runaway API spending.
 *
 * Two layers:
 *
 * 1. Monthly hard cap (LAIN_MONTHLY_TOKEN_CAP, default 60M). When exceeded,
 *    calls throw BudgetExceededError. Backstop for catastrophic runaways.
 *
 * 2. Daily soft cap (LAIN_DAILY_TOKEN_CAP, default disabled — findings.md
 *    P2:1126). When exceeded, calls sleep for LAIN_DAILY_THROTTLE_MS
 *    (default 5000) before proceeding. Smooths a 3-day runaway that would
 *    otherwise burn the monthly cap and lock the character out for 27 days.
 *    Set to 0 (or unset) to disable.
 *
 * Both counters live in the `meta` table under `budget:monthly_usage` and
 * `budget:daily_usage`. Updates go through atomicMetaIncrementCounter so
 * concurrent background loops don't clobber each other's increments.
 */

import { getLogger } from '../utils/logger.js';
import { atomicMetaIncrementCounter, getMeta, isDatabaseInitialized } from '../storage/database.js';

export class BudgetExceededError extends Error {
  constructor(used: number, cap: number) {
    super(`Monthly token budget exceeded: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens`);
    this.name = 'BudgetExceededError';
  }
}

function getCurrentMonth(): string {
  return new Date().toISOString().slice(0, 7); // YYYY-MM
}

function getCurrentDay(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getMonthlyCap(): number {
  const env = process.env['LAIN_MONTHLY_TOKEN_CAP'];
  if (env === '0') return 0; // disabled
  const parsed = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60_000_000;
}

function getDailyCap(): number {
  const env = process.env['LAIN_DAILY_TOKEN_CAP'];
  const parsed = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0; // default disabled
}

function getDailyThrottleMs(): number {
  const env = process.env['LAIN_DAILY_THROTTLE_MS'];
  const parsed = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

interface MonthlyUsage {
  month: string;
  tokens: number;
}

interface DailyUsage {
  day: string;
  tokens: number;
}

function getUsage(): MonthlyUsage {
  const raw = getMeta('budget:monthly_usage');
  if (!raw) return { month: getCurrentMonth(), tokens: 0 };
  const data = JSON.parse(raw) as MonthlyUsage;
  // Reset if it's a new month
  if (data.month !== getCurrentMonth()) return { month: getCurrentMonth(), tokens: 0 };
  return data;
}

function getDailyUsageRaw(): DailyUsage {
  const raw = getMeta('budget:daily_usage');
  if (!raw) return { day: getCurrentDay(), tokens: 0 };
  const data = JSON.parse(raw) as DailyUsage;
  if (data.day !== getCurrentDay()) return { day: getCurrentDay(), tokens: 0 };
  return data;
}

/**
 * Check the monthly hard cap. Throws BudgetExceededError if exceeded.
 *
 * Fail-open if the DB isn't initialized: scripts and tests that construct
 * providers without bootstrapping storage would otherwise die with a
 * "Database not initialized" error on every call. In production, storage
 * is always set up before any provider runs, so this branch never fires.
 */
export function checkBudget(): void {
  const cap = getMonthlyCap();
  if (cap === 0) return; // disabled
  if (!isDatabaseInitialized()) return;
  const usage = getUsage();
  if (usage.tokens >= cap) {
    throw new BudgetExceededError(usage.tokens, cap);
  }
}

/**
 * Enforce both budget layers before a call: throw on monthly hard cap,
 * sleep on daily soft cap. Async because the throttle uses setTimeout.
 *
 * findings.md P2:1126 — previously only the monthly hard cap was enforced,
 * so a runaway process could burn through 60M tokens in three days and
 * lock the character out for the remaining 27. The daily soft cap
 * smooths that by slowing down (not blocking) further calls once the
 * daily threshold is crossed.
 */
export async function enforceBudget(): Promise<void> {
  checkBudget();
  await maybeThrottleDaily();
}

async function maybeThrottleDaily(): Promise<void> {
  const cap = getDailyCap();
  if (cap === 0) return; // disabled
  if (!isDatabaseInitialized()) return;
  const daily = getDailyUsageRaw();
  if (daily.tokens < cap) return;
  const ms = getDailyThrottleMs();
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Record token usage after a successful LLM call.
 *
 * findings.md P2:1110 — uses a single atomic UPDATE so concurrent
 * callers (multiple background loops on the same character) can't
 * clobber each other's increments. Previously read-modify-write:
 * two parallel calls both read the old token count and each wrote
 * their own (old + delta), losing one increment.
 *
 * findings.md P2:1126 — also increments a separate daily counter
 * feeding the soft-cap throttle.
 */
export function recordUsage(inputTokens: number, outputTokens: number): void {
  const cap = getMonthlyCap();
  const dailyCap = getDailyCap();
  if (cap === 0 && dailyCap === 0) return; // both disabled
  if (!isDatabaseInitialized()) return; // see checkBudget() — same rationale

  const delta = inputTokens + outputTokens;
  const currentMonth = getCurrentMonth();
  const currentDay = getCurrentDay();

  if (cap > 0) {
    const stored = atomicMetaIncrementCounter({
      key: 'budget:monthly_usage',
      freshJson: JSON.stringify({ month: currentMonth, tokens: delta }),
      periodField: 'month',
      periodValue: currentMonth,
      counterField: 'tokens',
      delta,
    });

    // Warn at 80% — compare post-increment vs. pre-increment against
    // 0.8 * cap. Only fire on the first crossing.
    const after = (JSON.parse(stored) as MonthlyUsage).tokens;
    const before = after - delta;
    if (after >= cap * 0.8 && before < cap * 0.8) {
      const logger = getLogger();
      logger.warn(
        { used: after, cap, pct: Math.round((after / cap) * 100) },
        'Monthly token budget at 80%',
      );
    }
  }

  if (dailyCap > 0) {
    atomicMetaIncrementCounter({
      key: 'budget:daily_usage',
      freshJson: JSON.stringify({ day: currentDay, tokens: delta }),
      periodField: 'day',
      periodValue: currentDay,
      counterField: 'tokens',
      delta,
    });
  }
}

/**
 * Get current budget status (for admin API).
 */
export function getBudgetStatus(): {
  month: string;
  tokensUsed: number;
  monthlyCap: number;
  pctUsed: number;
  day: string;
  dailyTokensUsed: number;
  dailyCap: number;
  dailyPctUsed: number;
} {
  const cap = getMonthlyCap();
  const usage = getUsage();
  const dailyCap = getDailyCap();
  const daily = getDailyUsageRaw();
  return {
    month: usage.month,
    tokensUsed: usage.tokens,
    monthlyCap: cap,
    pctUsed: cap > 0 ? Math.round((usage.tokens / cap) * 100) : 0,
    day: daily.day,
    dailyTokensUsed: daily.tokens,
    dailyCap,
    dailyPctUsed: dailyCap > 0 ? Math.round((daily.tokens / dailyCap) * 100) : 0,
  };
}
