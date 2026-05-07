# `src/utils/index.ts`

Barrel re-export. 3 lines.

```ts
export * from './errors.js';
export * from './logger.js';
export * from './crypto.js';
```

## Gaps / bugs

- **`./timeout.js` is not re-exported.** `withTimeout` and `TimeoutError` are used at least in `memory/extraction.ts` — accessible only via direct `../utils/timeout.js` import. Inconsistent. Either add to the barrel or intentionally exclude (and document why). **P3**.
- No functions defined here. Zero logic to bug.

## Verdict

No findings to lift. P3 note about missing `timeout` re-export.
