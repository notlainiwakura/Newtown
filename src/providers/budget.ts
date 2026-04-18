/**
 * Daily token budget — prevents runaway API spending.
 *
 * Tracks total tokens used per calendar day. If the daily cap is exceeded,
 * subsequent LLM calls throw a BudgetExceededError instead of calling the API.
 *
 * Configure via LAIN_DAILY_TOKEN_CAP env var (default: 2,000,000 tokens/day).
 * Set to 0 to disable the cap entirely.
 */

import { getLogger } from '../utils/logger.js';
import { getMeta, setMeta } from '../storage/database.js';

export class BudgetExceededError extends Error {
  constructor(used: number, cap: number) {
    super(`Daily token budget exceeded: ${used.toLocaleString()} / ${cap.toLocaleString()} tokens`);
    this.name = 'BudgetExceededError';
  }
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getDailyCap(): number {
  const env = process.env['LAIN_DAILY_TOKEN_CAP'];
  if (env === '0') return 0; // disabled
  const parsed = env ? parseInt(env, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2_000_000;
}

interface DailyUsage {
  date: string;
  tokens: number;
}

function getUsage(): DailyUsage {
  const raw = getMeta('budget:daily_usage');
  if (!raw) return { date: getToday(), tokens: 0 };
  const data = JSON.parse(raw) as DailyUsage;
  // Reset if it's a new day
  if (data.date !== getToday()) return { date: getToday(), tokens: 0 };
  return data;
}

function saveUsage(usage: DailyUsage): void {
  setMeta('budget:daily_usage', JSON.stringify(usage));
}

/**
 * Check if we're under budget. Throws BudgetExceededError if not.
 */
export function checkBudget(): void {
  const cap = getDailyCap();
  if (cap === 0) return; // disabled
  const usage = getUsage();
  if (usage.tokens >= cap) {
    throw new BudgetExceededError(usage.tokens, cap);
  }
}

/**
 * Record token usage after a successful LLM call.
 */
export function recordUsage(inputTokens: number, outputTokens: number): void {
  const cap = getDailyCap();
  if (cap === 0) return; // disabled

  const usage = getUsage();
  usage.tokens += inputTokens + outputTokens;
  saveUsage(usage);

  // Warn at 80%
  if (usage.tokens >= cap * 0.8 && (usage.tokens - inputTokens - outputTokens) < cap * 0.8) {
    const logger = getLogger();
    logger.warn(
      { used: usage.tokens, cap, pct: Math.round((usage.tokens / cap) * 100) },
      'Daily token budget at 80%',
    );
  }
}

/**
 * Get current budget status (for admin API).
 */
export function getBudgetStatus(): { date: string; tokensUsed: number; dailyCap: number; pctUsed: number } {
  const cap = getDailyCap();
  const usage = getUsage();
  return {
    date: usage.date,
    tokensUsed: usage.tokens,
    dailyCap: cap,
    pctUsed: cap > 0 ? Math.round((usage.tokens / cap) * 100) : 0,
  };
}
