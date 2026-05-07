---
file: src/agent/proactive.ts
lines: 438
purpose: Lain-only proactive Telegram outreach. Scheduled reflection every 2.5h + silence-detection (6h of user quiet triggers reflection) + high-signal hook (on memory importance≥0.8, reflect after 5min). LLM decides to send or [SILENCE]. Rate-limited: 4/day, 1h cooldown. State persisted in meta.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/proactive.ts

## Function inventory (11)
- `loadRateState()` — 44.
- `persistRateState()` — 62.
- `pruneOldTimestamps()` — 71.
- `canSend(config)` — 79.
- `recordSend()` — 95.
- `getRemainingBudget(config)` — 102.
- `trySendProactiveMessage(message, trigger, config)` — 114: exported.
- `startProactiveLoop(config)` — 184: exported.
- `runReflectionCycle(trigger, config)` — 278.
- `buildReflectionPrompt(trigger, config)` — 326.
- `onHighSignalExtraction()` — 428: exported.

## Findings

### 1. Hard kill-switch inverted logic — disabled unless env is literally `'0'` (P1)

Line 123: `if (process.env['PROACTIVE_OUTREACH_DISABLED'] !== '0') { ... return false; }`

This means:
- Env unset → `undefined !== '0'` → TRUE → **disabled**.
- Env set to `''` → `'' !== '0'` → TRUE → **disabled**.
- Env set to `'false'` → TRUE → **disabled**.
- Env set to `'0'` → `'0' !== '0'` → FALSE → **enabled**.

So the entire proactive outreach feature is OFF BY DEFAULT unless someone explicitly sets `PROACTIVE_OUTREACH_DISABLED=0` (which reads as "disabled equals zero", ambiguous/confusing). The name says "DISABLED" but the value `'0'` enables it.

**This is actively confusing**. The comment says "Hard kill-switch — proactive telegram outreach is disabled" which suggests it's intentionally always-off, but the logic permits a specific escape hatch. Either:
- The intent is "proactive outreach is currently-off-by-default, set `=0` to re-enable" — which is semantically inverted from the env var's name.
- Or the intent is "disabled unless explicitly overridden" but the override value should be `'1'` not `'0'`.

Either way, the current name/value combination is a trap. A future operator reading `PROACTIVE_OUTREACH_DISABLED=0` will reasonably conclude "disabled is false, so outreach is enabled" — but parsing is string comparison, and `'0'` here means "enable". Someone setting `=false` or `=no` or `=off` expecting disablement will get the SAME disabled state they wanted, but by accident — the feature silently never runs.

**Observable consequence**: `startProactiveLoop` schedules reflections (line 239), the LLM reflects, produces a message, `trySendProactiveMessage` is called (line 317) — which immediately returns false at line 123. The entire LLM-reflection pipeline burns tokens for nothing.

### 2. `Lain-only` identity assumption with no guard (P2 — bundle)

Line 1 says "Proactive outreach system for Lain". Line 350 hardcodes `'Lain'` as the assistant display role. Line 397 hardcodes `'You are Lain Iwakura'` in the reflection prompt. No `LAIN_CHARACTER_ID === 'lain'` check at startup.

If Wired Lain (or any other character) starts this loop with Telegram env vars set, they'll reach out as "Lain" regardless of who they actually are. Identity corruption pathway.

Bundle with feed-health.ts #1, bibliomancy etc. — "runs on X only" without guard.

### 3. `TELEGRAM_CHAT_ID` is process-scoped — single user (P3)

Line 129: one chat ID. Assumes a single Telegram user who is "the user". Can't broadcast or differentiate multiple users. Consistent with the current single-player Lain UX.

### 4. Rate-limit state loaded once per process (P3)

Line 42-59. `rateStateLoaded` guards the load. But if `setMeta` fails (line 66 silent catch), subsequent re-loads won't happen — the in-memory state drifts from DB. Minor.

### 5. `sentTimestamps` pruned only when `canSend` or `getRemainingBudget` is called (P3)

Line 71-77. If the loop sits idle for >24h, old timestamps accumulate until next send attempt. Not a leak (capped by send cadence), cosmetic.

### 6. LLM response `[SILENCE]` sentinel check uses `includes` (P3)

Line 312: `response.includes('[SILENCE]')`. If LLM generates "I considered saying [SILENCE] but decided to say hello instead" — the substring match wins and no message is sent. Conservative fail. Minor quirk.

### 7. Recent outreach + memory context → prompt (P2 — bundle)

Lines 365, 381. `r.memory.content` and past outreach message content flow verbatim into reflection prompt. Memory content carries any prior-injection-persisted text. Outreach messages are Lain's own past outputs but still re-fed. Standard injection-amplification chain.

### 8. `applyPersonaStyle` runs AFTER rate-limit check (P3)

Lines 142-147. If styled message becomes empty after persona filter, rate limiter DOES NOT consume a slot (recordSend only at line 153). Good. But the LLM call already happened. Minor token waste.

### 9. `getInitialDelay` formula (P3)

Line 229: `cfg.reflectionIntervalMs + Math.random() * 30 * 60 * 1000`. On fresh start, waits 2.5h-3h before first reflection. Reasonable.

### 10. `onHighSignalExtraction` 5min delay uses raw `DEFAULT_CONFIG` (P3)

Line 436. Passes `DEFAULT_CONFIG` instead of whatever config was used by `startProactiveLoop`. If the caller overrides config (e.g., lower `maxMessagesPerDay`), the high-signal path ignores that override. Subtle config-drift.

### 11. `persistRateState` silent on failure (P3)

Line 67. Catch-all, no log. If DB is unavailable, rate state is memory-only and rebuilds from scratch on restart — potentially exceeding daily cap across process restarts. Unlikely but worth noting.

### 12. `grammy` Bot instantiated per-send (P3)

Line 150: `new Bot(botToken)` inside `trySendProactiveMessage`. Constructed fresh every send. Probably fine — grammy is stateless for one-shot sends — but wasteful. Could be module-level singleton.

### 13. `recordMessage` and `saveMemory` both fired after send (P3)

Lines 156, 161. Two separate persistence writes. If one succeeds and the other fails, the proactive message exists in one store but not the other. Data-consistency concern, mild. Acceptable given non-critical domain.

### 14. Trigger enum string mismatch (P3)

`ReflectionTrigger` at line 107 is `'scheduled' | 'silence' | 'high_signal'`. But `trySendProactiveMessage` accepts `trigger: string` (line 116). Caller could pass any string, including from external input. If any caller ever passes untrusted string, it'd land in `recordMessage` metadata and memory tags — minor but loosens type contract.

## Non-issues / good choices
- Persistent rate state across restarts.
- Daily cap + per-send cooldown.
- Silence-detection + scheduled + high-signal triggers — diverse outreach motivations.
- LLM-decides-silence via sentinel — avoids hollow pings.
- Kill-switch present (even if semantically confused).
- Explicit Telegram env check at loop start (line 194) — fails loud if unconfigured.
- `[SILENCE]` anti-spam guidance in prompt (line 419).

## Findings to lift
- **P1**: Kill-switch inverted logic — outreach off-by-default, `=0` is the obscure enable; name/value combination is a trap.
- **P2 (bundle)**: No `LAIN_CHARACTER_ID === 'lain'` guard — any character running this loop impersonates Lain.
- **P2 (bundle)**: Memory + outreach-history content as injection amplification surface.
- **P3**: High-signal path ignores config overrides.
- **P3**: Rate-state persistence silent-on-failure — can exceed daily cap on DB outage.

## Verdict
Solid scheduling + rate-limiting architecture. The inverted kill-switch logic at line 123 is the standout issue: the feature is plausibly off-by-default in production, consuming LLM tokens on reflections that never reach Telegram. Worth clarifying intent — either the name or the value is wrong. Beyond that, Lain-only hardcoding is the usual pattern in this section; the rest is careful engineering.
