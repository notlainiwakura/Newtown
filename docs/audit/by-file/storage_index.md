# `src/storage/index.ts`

Barrel re-export. 3 groups.

```ts
// database
export { initDatabase, getDatabase, isDatabaseInitialized, closeDatabase,
         query, queryOne, execute, transaction } from './database.js';

// keychain
export { getMasterKey, setMasterKey, getAuthToken, setAuthToken,
         generateAuthToken, deleteAuthToken, setCredential, getCredential,
         deleteCredential, listCredentials } from './keychain.js';

// sessions
export { generateSessionKey, createSession, getSession, findSession,
         getOrCreateSession, updateSession, deleteSession, listSessions,
         countSessions, deleteOldSessions, batchUpdateTokenCounts } from './sessions.js';
```

## Gaps / bugs

- **`getMeta` and `setMeta`** from `database.ts` are NOT re-exported. Callers who need them must import from `./database.js` directly. Minor inconsistency. **P3**.
- All three sibling modules covered. Clean.

## Verdict

No findings to lift. One P3 note.
