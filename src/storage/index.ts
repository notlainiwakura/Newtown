/**
 * Storage layer exports
 */

export {
  initDatabase,
  getDatabase,
  isDatabaseInitialized,
  closeDatabase,
  query,
  queryOne,
  execute,
  transaction,
} from './database.js';

export {
  getMasterKey,
  setMasterKey,
  getAuthToken,
  setAuthToken,
  generateAuthToken,
  deleteAuthToken,
  setCredential,
  getCredential,
  deleteCredential,
  listCredentials,
} from './keychain.js';

export {
  generateSessionKey,
  createSession,
  getSession,
  findSession,
  getOrCreateSession,
  updateSession,
  deleteSession,
  listSessions,
  countSessions,
  deleteOldSessions,
  batchUpdateTokenCounts,
} from './sessions.js';
