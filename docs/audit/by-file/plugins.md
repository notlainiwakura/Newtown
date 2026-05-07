# `src/plugins/` (loader.ts + index.ts)

Plugin subsystem intended to let third-party JS modules register tools and hooks into the agent pipeline. `loader.ts` is ~280 lines; `index.ts` is a barrel re-export.

**Critical context:** this entire module is **dead code**. Verified by grep across `src/`:

```
Grep loadPluginsFromDirectory|loadPlugin\(|enablePlugin|runMessageHooks|runResponseHooks
→ Found 2 files: src/plugins/loader.ts, src/plugins/index.ts
```

No caller outside the module. It is never imported from `agent/*`, `web/*`, `cli/*`, or anywhere else. The `Plugin` type, `loadPluginsFromDirectory`, `runMessageHooks` — none are wired into the runtime. Shipping this module is pure optionality; its value is gated on a future integration that hasn't happened.

## Function inventory

**loader.ts** (9 exports + types):
- `loadPlugin(pluginPath)` — reads `manifest.json`, dynamic-imports `manifest.main`, collects declared tools + hook callbacks
- `enablePlugin(name)` — registers the plugin's tools via `agent/tools.registerTool`, calls `onStart`
- `disablePlugin(name)` — calls `onStop`, unregisters tools
- `loadPluginsFromDirectory(pluginsDir)` — iterate subdirs, call `loadPlugin` each
- `getPlugin(name)`, `getAllPlugins()`, `getEnabledPlugins()`
- `unloadPlugin(name)` — disable + remove from registry
- `runMessageHooks(message)`, `runResponseHooks(response)` — sequential mutation chain across enabled plugins

**index.ts:** barrel re-exporting everything above.

## Findings

### P1 — Dead code with RCE primitives in a future integration

If any future commit wires `loadPluginsFromDirectory(somePath)` into the runtime, this module becomes an RCE primitive the moment the plugin directory is writable:

- `const mainUrl = pathToFileURL(mainPath).href; module = await import(mainUrl);` (line 64-69) — arbitrary JS loaded from disk, no signature check, no sandbox
- `manifest.main` is read from `manifest.json` and joined to `pluginPath` with no traversal guard; `{"main": "../../../etc/passwd.js"}` would be attempted
- Tools are added via `registerTool(tool)` (from `agent/tools.ts`) which gives the plugin the same LLM-surface capability as first-party tools — including the `new Function(…)` primitive already flagged as P1 in `agent/skills.ts`

An operator who drops a tarball in the wrong place and runs `./deploy.sh` could silently execute arbitrary code next boot. The attack surface is not speculative — it's that every mitigation (signing, sandbox, traversal guard) is missing and the module is ready to be wired up.

**Fix options (pick one):**
1. Delete the module entirely — it has no callers today and can be re-introduced with proper hardening when actually needed.
2. Keep the module but add a "never enabled in production" flag (e.g. require `LAIN_PLUGINS_ENABLE=1` and log a loud warning each boot) and a hardening TODO list: manifest signing, directory-traversal guard, per-plugin VM/worker isolation, explicit capability model.

The "delete it" option is preferred given the memory feedback note on character-integrity and the existing drift-lock concerns in the codebase. Dead code with attack surface is worse than no code.

### P2 — `registerTool` name collisions silently drop

Line 83-88: `loadPlugin` collects tools; line 137 `enablePlugin` calls `registerTool(tool)` per tool. `registerTool` in `agent/tools.ts` (verified in Section 7 audit) warn-logs name collisions but the second registration wins / loses arbitrarily depending on implementation. `unregisterTool(name)` then removes whichever tool currently holds the name — not necessarily this plugin's. Two plugins declaring the same tool name can trigger the wrong one to unload on `disablePlugin`.

**Fix:** track (pluginName, toolName) pairs on register; namespace tools by plugin at registration time.

### P2 — Hook chains leak mutations across plugins

`runMessageHooks` (line 255-265) threads a single mutable value through every enabled plugin's `onMessage` in iteration order. A malicious or buggy plugin can mutate the payload seen by downstream plugins. Plus: the iteration order comes from `Array.from(plugins.values())` which is insertion order — effectively load order, which is filesystem `readdir` order, which is non-deterministic across platforms.

**Fix:** either clone between hooks (expensive) or define an explicit composition model (pipe, broadcast, fan-out) with ordering guarantees.

### P2 — `manifest.main` path-traversal

Line 64: `const mainPath = join(pluginPath, manifest.main);` — `join` resolves `..` segments. A plugin manifest can point `main` outside its own directory. If `pluginPath` is `/opt/lain/plugins/good-plugin` and manifest says `"main": "../../../tmp/evil.js"`, the import succeeds.

**Fix:** after `join`, `path.resolve` and assert `startsWith(pluginPath)` — same pattern used (correctly) in `server.ts` skin loader.

### P2 — No plugin isolation / no capability model

Plugins execute in the main Node process with full `require`, `fs`, `fetch`, `process.env` access. No VM sandbox, no worker thread, no ambient-authority stripping. Combined with the "load arbitrary JS from disk" primitive: every plugin is effectively a full-privilege process add-on. Consistent with `agent/skills.ts::registerCustomTool` (Section 7, P1) — the plugin system would inherit the same lack of isolation.

**Fix:** if the module is kept, route plugin code through a `node:vm` or worker with explicit capability handoff.

### P3 — `enablePlugin` already-enabled path returns silently without error

Line 130-133: `if (plugin.enabled) { warn; return; }`. This is fine for idempotency but means the caller can't distinguish "already enabled" from "just enabled now" — inconsistent with `loadPlugin` which throws on bad manifest. Minor API inconsistency.

### P3 — `unloadPlugin` non-throw on missing name

Line 240: `if (!plugin) return;` — silent. `disablePlugin` and `enablePlugin` both throw on missing. Inconsistent.

### P3 — Empty barrel usefulness

`index.ts` just re-exports from `loader.ts`. No reason not to import from `./loader.js` directly. Minor convention issue; ignorable.

## Verdict

**Delete recommendation.** This module is a future attack surface that pays for itself only if / when plugins are actually needed. Until then, every line is a potential RCE path with no user value. If kept, the harden-before-wire list is: manifest signing, directory-traversal guard, per-plugin VM isolation, namespaced tool registry, explicit hook-composition model, capability-scoped env / fs access.

**Severity summary:** **1 P1**, **4 P2**, 3 P3 — all contingent on the module being wired up. Until then, the P1 is "dead code with pre-built attack surface awaiting activation," which is a specific class of finding worth tracking rather than handwaving.
