# `src/utils/crypto.ts`

Crypto primitives: token generation, key derivation (Argon2id), hashing, constant-time compare. 6 functions.

## Functions

### `generateToken(length = 32)`, line 14

**Purpose:** `randomBytes(length).toString('hex')` — 256-bit token by default.

**Gaps / bugs:**
- `length` is bytes (32 → 64 hex chars). Callers might pass `length: 64` expecting 64 chars and get 128. No doc comment on the unit. **P3**.
- CSPRNG via `node:crypto.randomBytes`. Correct.

### `generateRandomBytes(length)`, line 21

**Purpose:** thin wrapper. Same note on "bytes" unit. **P3**.

### `deriveKey(password, salt, config)`, line 28

**Purpose:** Argon2id KDF. Uses `memoryCost`, `timeCost`, `parallelism` from `KeyDerivationConfig`. Returns 32-byte raw buffer.

**Fits the system?** Yes — matches the DB-encryption config contract in `types/config.ts`.

**Gaps / bugs:**
- `hashLength: 32` hard-coded. Safe assumption (AES-256 key size). But if a future subsystem wants a 64-byte output, this function can't supply it. **P3**.
- `salt: Buffer` required but no length validation. Argon2 will throw if salt < 8 bytes; error surfaces. Minor.
- `raw: true` ensures only the derived key bytes come back (no Argon2 encoded string). Callers must persist `salt` separately — done in `storage/database.ts`, defer to that audit.

### `hashToken(token)`, line 48

**Purpose:** SHA-256 hex digest for storing tokens (one-way).

**Gaps / bugs:**
- SHA-256 (fast) on user-supplied tokens is appropriate for *opaque random tokens* (32+ bytes of entropy). If anyone ever uses `hashToken` on a low-entropy user password, it's immediately brute-forceable. Should be named `hashOpaqueToken` OR the file should add `hashPassword` using bcrypt/argon2 for non-opaque cases. **P3**.
- No output encoding parameter — locked to hex. Callers who want base64 have to convert. Fine.

### `secureCompare(a, b)`, line 55

**Purpose:** constant-time string equality.

**Gaps / bugs:**
- Length check short-circuit leaks length information. Mitigation is partial — for fixed-length tokens (where length is public), this is fine. For variable-length secrets, switch to `crypto.timingSafeEqual`. **P3**.
- `charCodeAt` operates on UTF-16 code units. For multi-byte characters, comparing high-surrogate followed by low-surrogate is still constant-time within equal-length strings. Fine for hex/base64; not robust for raw UTF-8 secrets. **P3**.
- Node has `crypto.timingSafeEqual(Buffer, Buffer)` built in. Would replace this whole function with a 3-liner that also handles non-ASCII correctly. Worth migrating. **P3**.

### `generateSalt(length = 16)`, line 70

**Purpose:** salt for KDF. 128 bits by default.

**Gaps / bugs:** None. 16-byte salt is conventional. Could note unit (bytes) in a doc comment.

---

## File-level notes

- No IV/nonce helpers for actual AES-GCM usage — presumably `storage/database.ts` handles that directly. Defer.
- `argon2` is a native-binding dependency. `sqlite-vec` is another. In a multi-binary deploy (droplet + local Mac dev), both must compile. Worth flagging separately as an infra concern, not a code bug.

## Verdict

No findings to lift. Several P3 notes about unit documentation, naming (hashToken vs hashPassword), and migrating to `crypto.timingSafeEqual`.
