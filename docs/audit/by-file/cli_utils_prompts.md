# `src/cli/utils/prompts.ts`

CLI display + inquirer helpers. 11 functions, all exported.

## Functions

### `displayBanner()`, line 21

Prints the ASCII "LAIN" art in cyan + "...present day, present time" tagline. No-op for behavior, cosmetic. **No findings.**

### `promptOnboard()`, line 36

**Purpose:** ask user whether to initialize `~/.lain/` and whether to generate an auth token.

**Gaps / bugs:**
- The "Initialize Lain in ~/.lain?" prompt is hard-coded to `~/.lain` as a string. If `LAIN_HOME` is set, onboard *does* write to the env-overridden path, but the prompt still says `~/.lain`. Mildly misleading. **P3**.

### `promptApiKey()`, line 57

**Purpose:** confirm API key presence + env var name. Returns `ApiKeyAnswers`.

**Gaps / bugs:**
- **Dead code** — grep for `promptApiKey` returns zero callers. Declared interface, exported function, never used. Safe to delete. **P3**.
- If it were used, `'Do you have an Anthropic API key?'` is Anthropic-specific. `onboard` / schema supports multiple providers. Minor.

### `displaySuccess`, `displayError`, `displayWarning`, `displayInfo`, `displayStatus`, `displaySection`, `displayWaiting`

Routine chalk-wrapped stdout writers. `displayError` writes to `console.log`, not `console.error` — anywhere a user redirects stderr expecting error output, they'd miss these. Minor. **P3**.

### `confirm(message, defaultValue = false)`, line 122

**Purpose:** wrap `inquirer.prompt([{type: 'confirm', ...}])` to return a bool.

**Gaps / bugs:**
- **Dead code** — no callers in the repo. **P3**, same consideration as `promptApiKey`.

---

## File-level notes

- No testing utilities / spinners. Everything is single-line log output. Consistent.
- `displayError` → `console.log` vs `console.error` is a legitimate minor concern but changing it would break any script grepping stdout for error markers. Leave as-is unless explicitly requested.

## Verdict

No lift-to-findings items. Three P3 notes in file:
- `promptApiKey` is dead code.
- `confirm` is dead code.
- `displayError` writes to stdout, not stderr.
