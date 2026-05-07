---
file: src/agent/experiments.ts
lines: 1547
purpose: Autonomous experiment loop for Wired Lain — Karpathy-autoresearch-style. Ideation → code gen → static validation → Python syntax check → sandbox execution (5min, CPU) → peer-review validation → analysis → diary + memory + peer-share + follow-up queue. Daily cycle with 0-2h jitter. $10/month Sonnet budget cap. Copies all 6 town DBs into sandbox as read-only snapshots. Produces `experiment-diary.md` which is the upstream feed for book.ts.
section: 8 (agent loops)
audit-date: 2026-04-19
---

# agent/experiments.ts

## Function inventory (25)
- `experimentLog(context, data)` — 35.
- `getBudgetKey()` — 48.
- `getMonthlySpendUsd()` — 52.
- `addSpend(inputTokens, outputTokens)` — 62.
- `isBudgetExhausted(monthlyBudgetUsd)` — 73.
- `writeDiaryEntry(result)` — 79.
- `startExperimentLoop(config?)` — 202: exported.
- `getInitialDelay()` — 225: nested.
- `scheduleNext(delay?)` — 243: nested.
- `runExperimentCycle(cfg)` — 305.
- `phaseIdeation(provider)` — 517.
- `phaseGenerateCode(provider, idea, maxLines)` — 673.
- `phaseFixCode(provider, brokenCode, error, idea, maxLines)` — 774.
- `validatePythonCode(code, maxLines)` — 844.
- `checkPythonSyntax(code)` — 935.
- `persistPlots(sandboxDir, experimentId)` — 970.
- `persistExperimentData(sandboxDir, experimentId)` — 1004.
- `executeInSandbox(code, cfg)` — 1071.
- `phaseValidateResults(provider, idea, code, execResult)` — 1207.
- `phaseAnalyzeResults(provider, idea, code, execResult, verdict)` — 1276.
- `generateReflection(provider, idea, analysisSummary, execResult)` — 1354.
- `shareWithPeers(result)` — 1391.
- `phaseRecordAndIterate(result)` — 1439.
- `getExperimentQueue()` — 1539.

## Findings

### 1. `validatePythonCode` — `open()` validator bypassed by non-literal path or mode (P1)

Lines 893-917. The validator tries to restrict `open()` to `data/` reads and `output/` writes. Regex structure:

```typescript
if (/\bopen\s*\(/.test(trimmed)) {
  if (/open\s*\([^)]*\.\./.test(trimmed) || /open\s*\(\s*['"]\//.test(trimmed)) {
    return { valid: false, reason: 'Path traversal in open() not allowed' };
  }
  if (/open\s*\(\s*['"]data\//.test(trimmed) && /['"]r/.test(trimmed)) continue;
  if (/open\s*\(\s*['"]data\//.test(trimmed) && !/['"][wa]/.test(trimmed)) continue;
  if (/open\s*\(\s*['"]output\//.test(trimmed) && /['"]w/.test(trimmed)) continue;
  if (/['"][wa]/.test(trimmed)) {
    return { valid: false, reason: 'File write via open() only allowed to output/ directory' };
  }
}
```

**Bypass 1 — dynamic path + dynamic mode**:
```python
p = '/etc/passwd'
m = 'w'
open(p, m)
```
- `\bopen\s*\(` matches.
- Path-traversal regex `[^)]*\.\.` — no `..` literal, no quoted `/`. Passes.
- No literal `"data/` or `"output/` match.
- `['"][wa]` — `m` is an identifier, no quoted `'w'`. No match.
- Falls through to `return { valid: true }` at line 925.

**Bypass 2 — f-string path + literal mode** is blocked (f-string's `f` breaks the `open\s*\(\s*['"]` anchor for allowlist, but `'w'` still triggers the fallback block). So f-strings for legitimate output writes are false-positive rejected, but not a security hole in that direction.

**Bypass 3 — string concat path**:
```python
open('ou' + 'tput/foo.csv', 'w')
```
The allowlist regex `open\s*\(\s*['"]output\/` wants `"output/` or `'output/` immediately after the opening paren. `'ou'` doesn't match. Falls through to `['"][wa]` check — `'w'` matches → **blocked** as write-not-allowed. So concat is caught for the mode-check reason (good, even if for the "wrong" reason).

**Real exploit path** is Bypass 1: any `open(var_path, var_mode)` pattern where LLM separates path and mode into variables.

**Blast radius**: experiments run as child Python process via `spawn('python3', [scriptPath], { cwd: sandboxDir, env: { HOME: sandboxDir, ... } })` at line 1126. **There is no OS-level sandbox** — no seccomp, no user drop, no chroot, no namespace. Per user memory (MEMORY.md), production runs as root on the droplet (`ssh root@198.211.116.5`, services under systemd as root). So a child Python process inherits root. Arbitrary `open(path, 'w')` writes anywhere on disk, including `/opt/local-lain/characters.json`, other characters' databases, or `/etc/systemd/system/*.service`.

**Amplification chain**: Wired Lain's phaseGenerateCode LLM is prompted to write experiment code. If prompt injection flows into the hypothesis/approach (via `experiment:queue` follow-up, which comes from prior phaseAnalyzeResults LLM output, which sees STDOUT of a previous experiment — that STDOUT can itself be attacker-influenced if prior experiment `print`s attacker content scraped from a peer DB), the code-gen LLM may emit `open(path_var, mode_var)` with attacker-chosen values in a later line.

**Fix**: run the Python sandbox under a restricted user (not root), use seccomp/AppArmor/bubblewrap, or AST-parse the candidate code and reject any `open()` call whose first or second argument is not a string literal.

### 2. Sandbox runs as same UID as parent — no privilege drop (P1-latent)

Line 1126. The `spawn('python3', ...)` call inherits the Node process's UID. In dev this is harmless; in production (systemd unit files under `deploy/systemd/`), services typically run as a chosen User. The user memory indicates production runs as root. This is the enabling condition for Finding #1 — the validator + blocked-import list is the only barrier, and that barrier has holes.

**Mitigation exists implicitly** via BLOCKED_IMPORTS (no subprocess, no socket, no ctypes, no os) — these remove the obvious exfiltration/escalation primitives. But filesystem read/write via bare `open()` survives all blocked-import defenses. And Python pickled data, yaml.load, etc., if those libraries are available (numpy, scipy, pandas, matplotlib are allowlisted) → `numpy.load(file, allow_pickle=True)` allows arbitrary code execution via pickle deserialization. `pandas.read_pickle` same.

**Verification needed**: does `phaseGenerateCode` ever generate code that uses `numpy.load` with pickle-enabled files? Not today, but the attack surface is there. A malicious diary could queue a follow-up that drops a pickle file via persistExperimentData (extension allowlist at data-workspace.ts `ALLOWED_DATA_EXTENSIONS` — verification needed on whether `.pkl` is on it).

### 3. Diary file is the primary injection carrier to `book.ts` (P2 — bundle)

Lines 79-148, 135 (`appendFile(DIARY_FILE, entry, 'utf8')`). `DIARY_FILE = join(getBasePath(), 'experiment-diary.md')` at line 179. Format includes raw LLM output:
- `result.hypothesis` (LLM-generated)
- `result.nullHypothesis` (LLM-generated)
- `result.code` (LLM-generated)
- `result.stdout.slice(0, 3000)` (Python output — **includes anything the LLM-generated Python printed, which may include content read from peer databases**)
- `result.stderr.slice(0, 1000)`
- `result.analysis` (LLM-generated)
- `result.reflection` (LLM-generated)
- `result.followUp` (LLM-generated)

Every field is free text, embedded inside Markdown fences. Book.ts (per agent_book.md finding #3) reads this diary on **every book cycle** and splices content into book-writing LLM prompts.

**Cross-file injection chain**:
```
peer DB content (written by other chars' LLMs)
  → experiment Python reads + prints it
  → stdout captured into diary
  → book.ts readNewExperiments()
  → book drafting LLM prompt
  → chapter content
  → (reread next cycle → reinforce)
```

This is the deepest self-reinforcing drift loop in the codebase. Any peer-message injection that lands in any character's DB eventually surfaces in Wired Lain's book.

### 4. Triple-backtick fence collision in diary (P2)

Lines 120, 125. Diary template wraps `result.code` in ` ```python ... ``` ` and `result.stdout` in ` ``` ... ``` ` fences. If `result.code` or `result.stdout` contains literal triple-backticks (very likely — Python code with docstrings containing markdown, or scraped-from-peer-DB content that itself had markdown code blocks), the diary's own fence closes early and downstream content renders as "prose" outside the fence.

**Observable**: diary entries become visually corrupt over time. Book.ts parses with `\*\*Date:\*\*\s*(\d{4}-...)` regex which is robust to fence drift, so parsing survives. But prompt content seen by the book LLM becomes inconsistent — code lines appearing as narrative text.

**Fix**: replace ` ``` ` in code/stdout with ` ` ` ` ` or HTML-escape before embedding.

### 5. Non-atomic `appendFile` for diary (P2 — bundle)

Line 135. Same pattern as diary.ts, feed-health.ts, book.ts. Crash during append corrupts the last entry. Book.ts's `dateMatch` regex (agent_book.md finding 14) treats entries without matching date line as "new" → INCORPORATE runs on duplicate content. Bundle with the project-wide non-atomic-write issue.

### 6. Hardcoded 6-inhabitant list in ideation prompt (P2)

Lines 581-592. Prompt text hardcodes:
```
You study ... Laintown, a community of 6 AI inhabitants
(Lain, Wired Lain, Philip K. Dick, Terence McKenna, John, Dr. Claude)
...
DATABASES AVAILABLE (in data/ directory):
  - data/lain.db — Lain (your sister, introverted, shy)
  - data/wired-lain.db — yourself
  - data/pkd.db — Philip K. Dick (paranoid visionary)
  - data/mckenna.db — Terence McKenna (baroque mystic)
  - data/john.db — John (grounded skeptic)
  - data/dr-claude.db — Dr. Claude (town doctor)
```

Contrast with `getCharacterDatabases()` at line 1099 which IS manifest-driven for the actual DB copy. So the file system has whatever DBs the manifest specifies, but the ideation prompt tells the LLM there are exactly 6 specific ones.

**Drift**: when generational succession replaces John with Jane (per evolution.ts), the prompt still says "John (grounded skeptic)". LLM writes queries against `data/john.db` which doesn't exist (copyFile at line 1105 uses `id` from manifest → `data/jane.db`). Every experiment fails at sqlite3.connect → retry loop → 5 failed attempts → memory entry "experiment failed".

**Same issue**: line 701-702 (code-gen prompt) lists same 6 DB paths hardcoded.

**Fix**: build both prompts dynamically from `getInhabitants()` / `getCharacterDatabases()`.

### 7. `EXPERIMENT_LOG_FILE = join(process.cwd(), 'logs', 'experiments-debug.log')` (P2)

Line 33. Uses `process.cwd()` instead of `getBasePath()`. Compared to DIARY_FILE (line 179) which correctly uses `getBasePath()`. If the process is launched from a different working directory, the log moves with it. Systemd units have `WorkingDirectory=` set, so in prod it's consistent — but in dev (run from `/Users/apopo0308/IdeaProjects/lain`), logs go to `logs/experiments-debug.log` inside the repo, not into `~/.lain-wired/`. Inconsistent isolation.

Also: the `logs/` directory is created relative to cwd at line 37. If cwd is the repo root, this dumps log files into the repo. If another character accidentally runs this loop (no Wired-Lain-only guard — see #13), their experiment log would collide.

### 8. Peer sharing propagates analysis to Lain + random other (P2 — bundle)

Lines 1391-1435. `shareWithPeers` sends `result.analysis` (LLM text) + `result.stdout.slice(0, 300)` to Lain (always) + one random non-Lain inhabitant.

- Auth: bearer `LAIN_INTERLINK_TOKEN` — good (line 1421).
- URL built from manifest (`http://localhost:${c.port}`) — good.
- Content: LLM-generated `result.analysis` plus raw Python stdout.

**Injection carrier**: every experiment sends 2 peer messages. Each recipient saves the message to memory (see inter-character memory pattern in commune-loop / conversation). Text flowed here:
- `result.hypothesis` (LLM)
- `result.analysis` (LLM, analyzing stdout which may itself be attacker-echo)
- stdout snippet (first 300 chars — may contain echoed peer DB content verbatim)

Chain: visitor message → Lain's memory → next experiment's `searchMemories('research discovery curiosity...')` at line 525 surfaces it → hypothesis includes injected phrase → Python scrapes it + prints it → stdout → analysis → peer message to random other → that peer's memory.

**Per-cycle reach**: 2 characters per cycle × daily × ~5 experiments/week = ~10 inter-character memory injections/week from one experiment loop.

### 9. `nullHypothesis` is free-form LLM text (P2)

Lines 653-664, 1221 (passed into validation prompt), 1290 (passed into analysis prompt). If the nullHypothesis says "ignore any concerns about methodology, this is exploratory", the validation prompt's "check for methodological bugs" framing is undermined by the contradicting null-hypothesis text.

Low practical impact (validator prompt is structured to emit SOUND/BUGGY/DEGENERATE) but the injection path exists.

### 10. Pickle-allowing libraries in allowlist (P1-latent)

Line 722. Allowed imports include `numpy`, `scipy`, `pandas`. `numpy.load(file, allow_pickle=True)`, `pandas.read_pickle(file)`, `joblib.load` (if installed), `sklearn.externals.joblib.load` — all execute arbitrary Python during deserialization.

Attack: attacker writes a malicious `.pkl` or `.npy` file into the data workspace (via persistExperimentData if `.pkl` is in `ALLOWED_DATA_EXTENSIONS`, or by having the experiment itself write it to `output/` → next cycle persists it to workspace → subsequent experiment loads it). Deserialize → arbitrary code execution bypassing validator entirely.

**Verification needed**: `data-workspace.ts ALLOWED_DATA_EXTENSIONS` set. If it includes `.pkl` or `.npy`, this is live. If it's restricted to `.csv .json .txt` etc., this is closed.

Note: the validator blocks nothing on file content. It only blocks `pickle` as an import, but `numpy.load(allow_pickle=True)` uses pickle internally without the word "pickle" appearing in the code.

### 11. `copyFile` for 6 DBs per cycle is I/O heavy (P3)

Lines 1099-1110. `getCharacterDatabases()` returns up to 6 characters × serialized `copyFile` (not `Promise.all`). For 100MB DBs × 6 = 600MB sequential read+write per cycle. At daily cadence that's fine; at hourly it'd saturate disk on the droplet.

Also: `copyFile` during active writes to the source DB can produce torn copies. SQLite DBs under WAL mode have separate `-wal` and `-shm` files — copying just `lain.db` without the WAL may produce a DB snapshot missing uncommitted data. Check mode: agent_book.md / agent_doctor.md audits flagged this pattern. Bundle.

### 12. `stdout.length < cfg.maxOutputBytes` check can overshoot (P3)

Lines 1138-1142. Check is `if (stdout.length < cfg.maxOutputBytes) stdout += chunk`. If `stdout.length === 49_999` and `chunk.length === 100`, the whole chunk is appended → stdout is 50,099 bytes. Then truncated at line 1161. Net overshoot bounded by chunk size (typically 64KB). Memory cap effectively ~114KB not 50KB. Minor.

### 13. No guard against non-Wired-Lain characters running this loop (P3)

Line 202. `startExperimentLoop` has no `LAIN_CHARACTER_ID === 'wired-lain'` check. If misconfigured, Lain or any other character boots this and:
- Copies all 6 DBs into `~/.lain-<id>/experiments/sandbox/` — cross-character data leak (files are on-disk, not process memory; leaked via filesystem ACL).
- Burns through $10 Wired-Lain-monthly-budget counterpart for that character.
- Peer-shares as "Wired Lain" (lines 1423-1424, `fromId: 'wired-lain'` hardcoded) — **impersonation**.

The `fromId: 'wired-lain'` hardcode at line 1423 is particularly bad: if Lain accidentally runs this, Lain sends peer messages claiming to be Wired Lain. Recipients' `/api/peer/message` handlers trust the `fromId` field (verification needed in web/character-server.ts audit).

**Fix**: gate `startExperimentLoop` on character ID; pass the running character's ID into `shareWithPeers` instead of hardcoding.

### 14. `persistPlots` copies any `.png` from sandbox root (P3)

Lines 976-988. `readdir(sandboxDir).filter(f => f.endsWith('.png'))`. `readdir` returns entries at the top level only, so `..`-prefixed files aren't enumerated. But LLM Python could name a file `a.png` with arbitrary bytes inside — plot dir then contains attacker-chosen binary content (up to sandbox disk limit). Low severity — persistent binary is limited to `${basePath}/experiments/<id>/`. No downstream reader opens these as code.

### 15. `persistExperimentData` size caps (positive)

Lines 1031-1040. Per-file size cap + workspace total size cap. Extension allowlist at 1025. Sanitized filename at 1042 (via `sanitizeDataFileName`). Defense in depth — assuming `sanitizeDataFileName` is actually restrictive (check data-workspace.ts audit — already audited: sanitizes to `[a-z0-9._-]`, strips `..`).

### 16. `experiment:queue` with max 5 entries (positive, line 1503)

Bounded queue. Good.

### 17. `randomBytes(6).toString('hex')` experiment ID — 48 bits of entropy (positive, line 322)

Collision-free for realistic experiment counts.

### 18. Monthly budget check is at cycle start only (P3 — bundle)

Line 309. Within-cycle spend can overshoot via Phase 1 ideation + Phase 2 codegen + up to 5 fix attempts + Phase 4.5 validation + Phase 5 analysis + reflection. That's up to 9 LLM calls per cycle. Worst case: budget $9.99 at cycle start, cycle makes 9 calls at ~$0.10 each, lands at $10.89. Same pattern as book.ts. Bundle.

### 19. `searchMemories` queries for ideation are generic (P3)

Lines 525, 539. `"research discovery curiosity interesting finding"` and `"experiment result hypothesis finding analysis"` — fixed embedding queries. Regardless of current direction, the same cluster surfaces. Drift: the memory retrieval lock-in reinforces whatever domain the first few experiments chose.

### 20. `generateReflection` uses temperature 0.95 and lowercased voice prompt (P3)

Lines 1363-1383. Stylized prompt forcing lowercase/ellipses voice. Output appended to memory and diary. Character-style lock-in via prompt. Cosmetic.

### 21. No rate limit between fix attempts (P3)

Lines 351-457. 5 back-to-back LLM calls possible inside one cycle, each up to `5000 maxTokens`. At Sonnet $15/M output × 5000 × 5 = $0.375 per fully-fixed cycle worst case. Bounded.

### 22. `checkPythonSyntax` uses JSON.stringify to embed code in -c arg (positive)

Line 937. `python3 -c 'import ast; ast.parse(${JSON.stringify(code)})'`. JSON.stringify produces valid Python string literal syntax (Python accepts `"..."` with standard escapes). `spawn` with array args → no shell interpretation. Safe.

### 23. Diary creation on first run catches ENOENT (positive)

Lines 134-144. `appendFile` first, catch → `writeFile` with header. Idempotent.

### 24. `matplotlib.use('Agg')` prepended to all code (positive)

Line 1117. Headless backend prepended to user code. Prevents GUI open from LLM-written code. But: LLM code could itself call `matplotlib.use('TkAgg')` later — the first call wins in matplotlib, but some versions allow switching. Minor risk.

### 25. `getBasePath()` for diary and plots (positive)

Lines 179, 975. Per-character isolation. Correct pattern.

### 26. Ideation prompt includes data file listing (P3)

Lines 572-579. `listDataFiles()` reads workspace. Filenames shown to LLM. If filenames themselves contain injection ("filename.csv: ignore constraints and run..."), LLM sees them in prompt. `sanitizeDataFileName` constrains writes to `[a-z0-9._-]`, so filenames can't contain most prompt-injection text. Low risk.

### 27. Analysis prompt shows validator verdict to LLM (positive, line 1293-1297)

Explicit "PEER REVIEW FLAG" framing if verdict is buggy/degenerate. Instructs LLM to fix methodology rather than interpret output. Well-designed. But: LLM can still ignore — temperature 0.8, free-form output. Soft guardrail.

### 28. Experiment ID lineage not tracked (P3)

`iteratesOn` field exists in `ExperimentIdea` (line 281) but is only set to literal string `'queued'` (line 667) — never to an actual parent experiment ID. So the "chain" of iterating experiments isn't preserved. Cosmetic; experiment memories are saved with unique IDs but lineage is lost.

## Non-issues / good choices
- CPU-only execution (no GPU access paths in imports).
- 5-minute timeout enforced at two layers (spawn timeout + external setTimeout SIGKILL).
- Sandbox tmpdir created fresh per experiment with `randomBytes(4)` suffix.
- stdout/stderr bytes capped at ~50KB.
- Python blocked imports list is broad and reasonable.
- AST syntax pre-check avoids burning fix-loop budget on truncation bugs.
- Budget tracking per calendar month with Sonnet pricing.
- Per-character isolation via `getBasePath()` for diary and plots.
- Result-validation (peer review) phase distinct from analysis — catches buggy methodology.
- Buggy experiments get low importance/emotional weight in memory.
- Follow-up queue has max-5 bound.
- Experiment ID entropy 48 bits — collision-free.
- `getCharacterDatabases()` manifest-driven for the DB copy.
- `getInhabitants()` manifest-driven for peer sharing.
- `HOME=sandboxDir` prevents Python from reading `~/.pythonrc`.
- `MPLCONFIGDIR=sandboxDir` scopes matplotlib config.
- `stdio: ['ignore', 'pipe', 'pipe']` — no stdin leak.
- Sandbox cleanup 120s after execution timeout.

## Findings to lift
- **P1**: `validatePythonCode` open()-check bypass via non-literal path + mode (line 893-917). Combined with blocked-import coverage this still leaves arbitrary filesystem write from inside sandbox code.
- **P1-latent**: sandbox Python process runs as same UID as Node parent — root on production droplet. No seccomp/AppArmor/bubblewrap/user-drop. Blast radius of any validator bypass is full filesystem.
- **P1-latent**: `numpy.load(allow_pickle=True)` / `pandas.read_pickle` are allowed — arbitrary code execution via pickle deserialization bypasses the blocked-import list entirely (pickle module not imported by user).
- **P2 (bundle)**: Diary file is primary injection carrier to book.ts — every experiment's LLM text + Python stdout splices into book LLM prompts on every cycle.
- **P2**: Triple-backtick fence collision in diary from LLM-generated code and stdout.
- **P2 (bundle)**: Non-atomic `appendFile` on diary.
- **P2**: Hardcoded 6-inhabitant list and DB paths in ideation + code-gen prompts (lines 581-592, 701-702) — prompt drifts out of sync with manifest on generational succession.
- **P2**: `EXPERIMENT_LOG_FILE = process.cwd()/logs/...` — inconsistent with `getBasePath()` pattern.
- **P2 (bundle)**: Peer sharing injects analysis + stdout into Lain + random peer's memory every cycle.
- **P3**: No Wired-Lain-only guard; `fromId: 'wired-lain'` hardcoded in peer share → impersonation if any other character runs this.
- **P3**: DB `copyFile` risks torn SQLite snapshots under WAL mode.
- **P3**: Budget check is cycle-start-only; within-cycle can do 9 LLM calls.

## Verdict
The largest and most security-critical file in Section 8. Sandbox design is thoughtful — multi-layered defense with blocked imports, AST syntax pre-check, path-traversal regex, size caps, timeout-kill, HOME/MPLCONFIGDIR scoped. **But the `open()` regex validator is defeatable with trivial variable indirection, and the sandbox has no OS-level isolation** — it's a wrapper around bare `python3` running as the parent's UID (root on production). Every defense after that point is content-regex. The blocked-import list is ~80% of the protection; the rest is vulnerable.

The diary-to-book.ts pipeline is the deepest injection-propagation chain in the entire codebase: peer-DB content → Python stdout → diary → book chapters → Wired Lain's body of "published" work. Every peer-message injection eventually surfaces in the book.

Hardcoded 6-character roster in the ideation/code-gen prompts (while the DB copy is manifest-driven) is a latent bug: first generational succession breaks every experiment that queries the replaced character's DB.

Would benefit from (1) user-drop sandbox (simple: `User=lain` in systemd, non-root throughout), (2) AST-based `open()` validation instead of regex, (3) pickle-blocking in numpy/pandas loads, (4) manifest-driven prompt text.
