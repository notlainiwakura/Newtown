# `src/cli/commands/character.ts`

Loads a character by id from the manifest and starts its server. 2 functions.

## Functions

### `parsePeerConfig(characterId)`, line 15

**Purpose:** prefer `PEER_CONFIG` env var (injected via systemd `EnvironmentFile` in prod) over manifest-derived peers. Falls back to `getPeersFor(characterId)` which reads `characters.json`.

**Fits the system?** Yes — matches CLAUDE.md's "PEER_CONFIG must be in EnvironmentFile" note. The dual-source lets prod override peer URLs (droplet local-network URLs) without editing the repo manifest.

**Gaps / bugs:**
- **P2** — After `JSON.parse`, the result is cast to `PeerConfig[]` without shape validation. A malformed env var that happens to parse (e.g. `{}` instead of `[]`, or an array of wrong-shape objects) would silently become the peer list and fail later with opaque errors in `startDesireLoop`, `startCommuneLoop`, etc. Should validate: `Array.isArray` + each entry has `id`, `name`, `url` strings.
- On JSON parse failure the code warns and falls back to manifest. That's silent degradation — if prod *relied* on the env override (peer URLs different from manifest defaults), peers would wrongly be the manifest values. Not a bug per se, but the warning goes to stderr and might be missed in journal. **P3**.

**Unexpected consequences:** fallback path can use wrong peers if env is malformed.

### `startCharacterById(characterId, portOverride?)`, line 27

**Purpose:** resolve character from manifest, build `CharacterConfig`, call `startCharacterServer`.

**Fits the system?** Partially. It uses `entry.id`, `entry.name`, `entry.port`, `entry.possessable`, and `parsePeerConfig(entry.id)`. Does NOT use `entry.homeDir` or `entry.systemdUnit` — those are consumed by the setup/deploy scripts and systemd unit files, not at runtime, which is correct. `LAIN_HOME` env var (set by the unit file) is what actually routes per-character DB paths.

**Gaps / bugs:**
- **P1 — `publicDir` points to a nonexistent directory.** Line 38: `publicDir: join(SRC_DIR, 'src', 'web', \`public-${entry.id}\`)`. Verified: no `src/web/public-*/` directories exist, only the shared `src/web/public/`. Consequences traced through `character-server.ts`:
  - `serveStatic(config.publicDir, '/')` → `readFile` throws → returns `null`.
  - Non-owner visitor: falls through to `302 /commune-map.html` (works by accident).
  - Owner hitting `/` on PKD/McKenna/John/Dr-Claude/Hiru: gets `404 Not found`. No chat UI served. This means the owner has no direct route to chat with an inhabitant character via the character server.
  - Owner requesting CSS/JS/images from the character server: all 404. Any nav-bar / telemetry scripts injected by nginx `sub_filter` won't load either.
  - **Fix options:** either `publicDir: join(SRC_DIR, 'src', 'web', 'public')` (share the main frontend), or delete the static-file serving from character-server and make it API-only.
  - Needs design decision — defer the fix until after auditing `character-server.ts` so I can see whether owner chat for inhabitants is supposed to live on the main server (routed) or the character server (direct).

- Error path calls `process.exit(1)` without graceful shutdown. No loops have started yet at this point so nothing to unwind — fine.

**Unexpected consequences:** The broken `publicDir` is why nginx's `sub_filter '</head>'` to inject `laintown-nav.js` never finds a `</head>` (no HTML served → nothing to sub_filter). The nav bar and telemetry script that the nginx config expects to inject on `/pkd/`, `/mckenna/`, etc. never actually appear because the upstream 404s before any HTML is produced.

---

## File-level notes

- Build output (`dist/cli/commands/character.js`) resolves `SRC_DIR` to the repo root regardless of whether running from `dist/` or `src/`. OK.
- No tests for `parsePeerConfig` malformed-env behavior. Would be worth adding to the regression suite.

## Verdict

**Lift to findings.md:**
- P1: `publicDir` points at nonexistent `public-<id>` directories. Character-server static file serving is dead code; breaks owner chat UI for inhabitants and breaks nginx nav-bar injection.
- P2: `parsePeerConfig` does no shape validation on `PEER_CONFIG` JSON.
