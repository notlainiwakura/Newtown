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

// Memory
export * from './memory/index.js';

// Security
export * from './security/index.js';

// Plugins
export * from './plugins/index.js';

// Utilities
export * from './utils/index.js';

// CLI runner
import { run } from './cli/index.js';

// Run CLI if this is the main module
const isMain =
  process.argv[1]?.endsWith('newtown.js') ||
  process.argv[1]?.endsWith('lain.js') ||
  process.argv[1]?.endsWith('newtown') ||
  process.argv[1]?.endsWith('lain') ||
  process.argv[1]?.endsWith('index.js') ||
  process.argv[1]?.endsWith('index.ts') ||
  process.argv[1]?.includes('dist/index') ||
  process.argv[1]?.includes('src/index');

if (isMain) {
  run().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
