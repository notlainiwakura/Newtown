# `src/providers/budget.ts`

Monthly token-budget guardrail. 96 lines. Tracks per-character (per-process-DB) total tokens per calendar month. Exceeding the cap throws `BudgetExceededError` on `checkBudget()`.

## Functions

### `BudgetExceededError`, line 14

Simple Error subclass.

### `getCurrentMonth()`, line 21

`new Date().toISOString().slice(0, 7)` — always UTC.

**Gaps / bugs:**
- **UTC-only.** An operator in UTC-8 thinking "start of May" resets the budget at 4pm PT on April 30. For a casual multi-TZ deployment this is confusing; for a single-operator setup, a non-issue. **P3.**

### `getMonthlyCap()`, line 25

Reads `LAIN_MONTHLY_TOKEN_CAP`, defaults to 60M tokens, 0 means disabled.

**Gaps / bugs:**
- **`env === '0'` check before `parseInt`** — good, handles disabling.
- **No minimum sanity check.** Setting `LAIN_MONTHLY_TOKEN_CAP=1` means a 1-token cap. Probably not intentional — but the code allows it. Fine. **P3.**
- **No per-provider or per-character override.** Every character shares the same cap env var at the process level — which matches per-process DB isolation, so effectively it IS per-character, but not per-provider. If Anthropic is cheap and OpenAI is expensive, no way to set tighter budget for OpenAI. Tied to ProviderConfig tunables P2. **P3.**

### `getUsage()`, line 37

Reads `budget:monthly_usage` meta, returns `{month, tokens}`.

**Gaps / bugs:**
- **`JSON.parse` without try/catch.** A corrupt `meta` row crashes the budget layer — which crashes every LLM call via the checkBudget gate. Operators would see the character hang indefinitely with only a cryptic "Unexpected token" in logs. **P3.**
- **New-month detection is lazy.** Only fires when `getUsage` is called. Correct but means budget resets on first activity of the new month, not at midnight. OK.

### `saveUsage(usage)`, line 46

`setMeta('budget:monthly_usage', JSON.stringify(usage))`. Trivial.

### `checkBudget()`, line 53

Throws if over budget.

**Gaps / bugs:**
- **Called by whom?** Only by callers who opt in. If some agent paths call `checkBudget` before a request but others don't, budget overrun is possible from the unguarded paths. Need to audit during agent-loop review. **P2 — lift**: `checkBudget` not centrally enforced — relies on every caller remembering to call it; any uncovered path can overrun.
- **Race on usage read.** Two concurrent callers both pass the check at 59.99M used, then both proceed with 10k-token calls. Total ends up at 60.02M. Acceptable overshoot pattern (not a rollback). **P3.**

### `recordUsage(inputTokens, outputTokens)`, line 65

Adds tokens to the monthly count.

**Gaps / bugs:**
- **Read-modify-write without transaction.** Two concurrent `recordUsage` calls: both read old usage, both add their delta, last writer wins. One call's tokens are lost. On a character with 5+ parallel background loops, this under-counts usage by the concurrent-call rate. **P2 — lift**: `recordUsage` is read-modify-write without transaction; concurrent calls under-count tokens, making the cap leakier than advertised.
- **`inputTokens + outputTokens` sums them equally.** Output tokens cost 3-5x more at Anthropic. A character doing long-form output spends more dollars per token than the budget reflects. Budget is token-count, not dollars. **P3** — by design, but document the mismatch.
- **No cache-token awareness.** `inputTokens` from the Anthropic provider includes cache reads (which cost 10% of normal input tokens). Budget treats cached input as equal to fresh input — overcounts cost in that direction. Tied to base.ts cache-token usage P2. **P3.**
- **80% warning fire-once logic** (`(usage.tokens - inputTokens - outputTokens) < cap * 0.8 && usage.tokens >= cap * 0.8`) — correctly fires on crossing. But only 80%. No 90%/95%/100% warnings. Operators get one ping then nothing until hard cutoff. **P3.**
- **No emit to event bus / activity feed.** Budget warnings only go to logger. Character doesn't "know" it's running low — can't proactively throttle its own behavior (skip a curiosity pass, defer a long generation). **P3** — potential feature.

### `getBudgetStatus()`, line 86

Returns status object for admin API.

**Gaps / bugs:**
- Fine. Includes `pctUsed` as rounded percent. OK.

---

## File-level notes

- **No granular cadence.** Monthly cap only — no daily/weekly sub-caps. A runaway process that blows through 60M tokens in 3 days is locked out for the next 27 days. An operator has no way to say "max 2M/day smoothed". **P2 — lift**: no daily/weekly budget sub-caps; a runaway locks out the character for weeks.
- **No reset API.** If cap is hit spuriously (bug, attack, test run), operators must `sqlite3` into the meta table to reset. **P3.**
- **No per-provider tracking.** A character using Anthropic + OpenAI (via fallback) can't see per-provider spend — just aggregate. **P3.**
- **Reference in CLAUDE.md recent commits:** `cd69b58 refactor(budget): shift from daily to monthly cap` — the daily→monthly shift is recent. Worth verifying any lingering daily references elsewhere in the codebase were updated. Probably fine.
- **No "what blocks when the cap is hit" docs.** `BudgetExceededError` is thrown. What do callers do? The agent loop should probably fail gracefully with a user-visible "I'm at capacity this month" message, not a stack trace. Needs verification at agent-layer audit.

## Verdict

**Lift to findings.md:**
- **P2**: `checkBudget` is not centrally enforced — every caller must remember to invoke it before making LLM calls. Any uncovered path (new agent loop added, tool handler that calls a provider directly, etc.) bypasses the budget. Centralize by wrapping every provider call in a budget-checking decorator.
- **P2**: `recordUsage` is read-modify-write without transaction. Concurrent calls (common on characters with parallel background loops) lose token counts. The monthly cap leaks proportionally to concurrency. Use a single-statement UPDATE with `json_set` or equivalent atomic increment.
- **P2**: No sub-monthly cadence (daily / weekly). A character hitting the 60M cap on day 3 is locked out for 27 days. Add a soft daily cap that throttles without hard-blocking, or implement a token-bucket smoothing algorithm.
