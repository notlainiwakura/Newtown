---
file: src/agent/data-workspace.ts
lines: 109
purpose: Per-character experiment-data directory (getBasePath()/experiment-data/). Bounded to 100MB total, 10MB per file, whitelisted extensions (.csv/.json/.txt/.tsv). Sanitization rejects traversal, absolute paths, disallowed extensions, length outliers.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/data-workspace.ts

## Function inventory (5)
- `getDataWorkspacePath()` — 12: exported.
- `ensureDataWorkspace()` — 26: exported.
- `getDataWorkspaceSize()` — 33: exported.
- `listDataFiles()` — 57: exported.
- `sanitizeDataFileName(name)` — 85: exported.

## Findings

### 1. Per-character isolation via `getBasePath()` (positive)

Line 13: `join(getBasePath(), 'experiment-data')`. Correct character-scoped path. Contrast with other files' cwd-relative traps. One of the cleanest examples in Section 8.

### 2. `sanitizeDataFileName` is careful (positive)

Lines 85–109. Strips path components via `basename`, rejects `..`, absolute paths, disallowed extensions, and length outliers. Defense-in-depth: strips separators AFTER basename. Returns null on any failure.

### 3. Double-extension / polyglot issues (P3)

`extname(clean).toLowerCase()` checks only the last extension. A file `malicious.csv.exe` gets `.exe` → rejected (good). `malicious.exe.csv` gets `.csv` → allowed. Neither side runs arbitrary code from the data workspace per this file — it's just stored. OK.

### 4. No content-type validation (P3)

`.json` extension is trusted as JSON, `.csv` as CSV, etc. If an experiment reads `.json` and `JSON.parse`s, a `.json` file full of non-JSON still produces a runtime error — caller's concern.

### 5. `getDataWorkspaceSize` uses sync `readdirSync` + per-file `statSync` (P3)

Line 36–44. Sync I/O. Called during capacity checks. For small N (typical `<100` files) this is fine.

### 6. `listDataFiles` silently drops files exceeding `MAX_SINGLE_FILE_BYTES` (P3)

Line 67. Oversized files still exist on disk but aren't listed. The file isn't visible to the character's experiment loop but occupies the 100MB budget. Subtle: `getDataWorkspaceSize` counts them, `listDataFiles` doesn't.

**Result**: an oversize file at the limit effectively blocks writes (via size check) without being listable for cleanup.

### 7. No garbage-collection / expiry (P3)

Files accumulate indefinitely until the character hits 100MB. No TTL, no LRU. A misbehaving experiment loop that keeps downloading/writing will eventually reach the cap and then silently fail to write more. No observable alert.

### 8. `ALLOWED_DATA_EXTENSIONS` is a hardcoded Set (P3)

Line 23. New formats require code changes. Minor.

## Non-issues / good choices
- `getBasePath()` usage — correct per-character scoping.
- `mkdirSync(dir, { recursive: true })` — idempotent.
- Whitelist over blacklist on extensions.
- Read-only functions have no side effects.
- `basename` + separator replacement + traversal check is layered defense.

## Findings to lift
- **Positive (note on pattern)**: correct use of `getBasePath()` for character isolation — contrast with other files' cwd-relative failures.
- **P3**: Oversized files stuck in the budget but invisible to `listDataFiles` — no cleanup path.
- **P3**: No TTL / GC — data accumulates until cap, then silently fails writes.

## Verdict
Tiny utility file that does one thing well. Size/extension guards are correct. Only real concern is the invisible-oversized-file footgun. Not a security issue; a maintainability paper-cut.
