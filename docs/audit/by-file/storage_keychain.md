# `src/storage/keychain.ts`

`keytar`-based OS keychain wrapper. 10 functions.

## Functions

### `getMasterKey()`, line 16

**Purpose:** return the master key used for DB encryption key derivation. Prefer `LAIN_MASTER_KEY` env var; otherwise read from keychain; generate if absent.

**Fits the system?** Yes — per CLAUDE.md's keychain model.

**Gaps / bugs:**
- **First-run generates a new master key and saves it.** On a droplet with no existing keychain entry, the first call silently creates a master key. If any process had previously opened an encrypted DB with a DIFFERENT keychain entry (e.g. the system keychain was wiped), the first call here creates a new master key, and the old DB is un-decryptable forever. **P2** — lift. Real scenario: full droplet rebuild without migrating `/root/.lain-*/lain.db`.
- **`LAIN_MASTER_KEY` env var override** — necessary for systemd-managed services on Linux droplets where there's no GUI keychain. Per MEMORY, this works. Good.
- **No validation of env key format/length** — a user putting `LAIN_MASTER_KEY=hello` would produce a usable-but-weak master key. Should validate minimum length. **P3**.
- Returns `string` — keytar stores as UTF-8. If the env key contains control characters, behavior is undefined. Unlikely.

### `setMasterKey(key)`, line 42

**Purpose:** overwrite the master key. For tests / recovery.

**Gaps / bugs:**
- Dangerous if called in prod with a different key — immediately breaks existing encrypted DBs. No guard, no warning. **P3** — rename to `dangerouslySetMasterKey` or similar.
- Does not update the env-var value; subsequent calls to `getMasterKey` with `LAIN_MASTER_KEY` set would still return the env value. Inconsistent. **P3**.

### `getAuthToken()`, `setAuthToken()`, `generateAuthToken(length=32)`, `deleteAuthToken()`, lines 56–102

CLI auth token storage. Round-trip through keychain. Fine.

**Gaps / bugs:**
- `generateAuthToken` default length 32 bytes. Called by `onboard.ts`. Output is hex (64 chars). Consistent with `utils/crypto.ts`.
- No rotation / expiry. Token lives forever until explicitly deleted. **P3** — nice-to-have.

### `setCredential(account, value)`, `getCredential(account)`, `deleteCredential(account)`, `listCredentials()`, lines 107–159

Generic keychain accessors.

**Gaps / bugs:**
- `listCredentials()` returns `Array<{ account: string }>` — drops the passwords from the keytar result. Good (PII hygiene). But a caller who wants the values must call `getCredential` in a loop, which may prompt for keychain access on macOS repeatedly. **P3**.
- **`setCredential` without namespace separator conventions.** Any caller can pick any `account` string. Without a convention (`apikey:anthropic`, `token:auth`), collisions between subsystems are possible. Currently only `MASTER_KEY_ACCOUNT` and `AUTH_TOKEN_ACCOUNT` are used internally — future providers might use keychain too. **P3** — doc.

---

## File-level notes

- `SERVICE_NAME = 'lain'` — correct for keychain namespacing. Each character process uses the same service name, so all characters share the same master key (via keychain). That's intentional: characters aren't cryptographically isolated from each other at the storage layer. OK as long as `LAIN_HOME` separates their DBs (which it does).
- Every function wraps errors in `KeychainError`. Consistent.
- No pre-flight check that `keytar` native binding loaded. On some Linux distros without `libsecret`, keytar throws at import time. Would fail fast; no graceful fallback other than `LAIN_MASTER_KEY` env var. Already noted in MEMORY.

## Verdict

**Lift to findings.md:**
- P2: `getMasterKey` silently generates a new master key on first miss. A droplet rebuild without migrating the keychain entry produces a new master key and permanently loses access to any existing encrypted DBs. Fix: log warning loudly on generation, document recovery path, consider refusing to generate if an existing DB file is detected.
