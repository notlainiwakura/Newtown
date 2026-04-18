/**
 * Web command - Start the web interface
 */

import { startWebServer } from '../../web/server.js';
import { displayError } from '../utils/prompts.js';

/**
 * Start the web interface
 */
export async function startWeb(port: number = 3000): Promise<void> {
  try {
    await startWebServer(port);
  } catch (error) {
    displayError(`Failed to start web server: ${error}`);
    process.exit(1);
  }
}
