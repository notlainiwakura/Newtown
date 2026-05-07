# `src/types/index.ts`

Barrel re-export. 4 lines.

```ts
export * from './config.js';
export * from './gateway.js';
export * from './session.js';
export * from './message.js';
```

## Gaps / bugs

- All four sibling type files are re-exported. No omissions noted.
- No namespace separation — if any two files exported a type with the same name, TypeScript would error at compile time. Currently clean.

## Verdict

No findings. Trivial file.
