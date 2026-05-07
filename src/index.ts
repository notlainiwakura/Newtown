/**
 * Lain - A privacy-first personal AI assistant
 *
 * Main entry point
 */

// Types
export * from './types/index.js';

// Configuration
export * from './config/index.js';

// Storage
export * from './storage/index.js';

// Gateway
export * from './gateway/index.js';

// Agent (excluding GatewayError which conflicts with utils)
export {
  loadPersona,
  buildSystemPrompt,
  applyPersonaStyle,
  registerTool,
  unregisterTool,
  getToolDefinitions,
  executeTool,
  executeTools,
  getConversation,
  addUserMessage,
  addAssistantMessage,
  clearConversation,
  initAgent,
  getAgent,
  isAgentInitialized,
  processMessage,
  shutdownAgents,
} from './agent/index.js';

// Providers
export * from './providers/index.js';

// Channels
export * from './channels/index.js';

// Memory
export * from './memory/index.js';

// Security
export * from './security/index.js';

// Utilities
export * from './utils/index.js';

// CLI runner
import { run } from './cli/index.js';
import { isCliEntryPath } from './cli/entry-path.js';

const isMain = isCliEntryPath(process.argv[1]);

if (isMain) {
  run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
