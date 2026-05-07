/**
 * Gateway module exports
 */

export {
  startServer,
  stopServer,
  isServerRunning,
  getServerStatus,
  getServerPid,
  isProcessRunning,
  broadcast,
  getConnectionCount,
} from './server.js';

export {
  authenticate,
  isAuthenticated,
  getConnection,
  setConnectionAgent,
  deauthenticate,
  getAuthenticatedConnections,
  getAuthenticatedConnectionCount,
  clearAuthentications,
  refreshTokenCache,
  fingerprintToken,
  touchConnection,
  sweepIdleConnections,
} from './auth.js';

export {
  configureRateLimiter,
  canConnect,
  canAuthenticate,
  canRequest,
  registerConnection,
  unregisterConnection,
  getRateLimitStatus,
  resetRateLimiter,
} from './rate-limiter.js';

export { registerMethod, unregisterMethod, handleMessage } from './router.js';
