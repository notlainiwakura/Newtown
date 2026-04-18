/**
 * Chat command - Direct chat mode (stub for Phase 1)
 */

import { createInterface } from 'node:readline';
import { connect } from 'node:net';
import { nanoid } from 'nanoid';
import { getPaths } from '../../config/index.js';
import { getAuthToken } from '../../storage/keychain.js';
import { getServerPid, isProcessRunning } from '../../gateway/server.js';
import {
  displayBanner,
  displayError,
  displayInfo,
  displayWarning,
} from '../utils/prompts.js';
import type { GatewayMessage, GatewayResponse } from '../../types/gateway.js';

/**
 * Start interactive chat mode
 */
export async function chat(): Promise<void> {
  displayBanner();

  const paths = getPaths();

  // Check if gateway is running
  const pid = await getServerPid(paths.pidFile);
  if (!pid || !isProcessRunning(pid)) {
    displayError('Gateway is not running');
    displayInfo('Start the gateway with: lain gateway');
    process.exit(1);
  }

  // Get auth token
  const token = await getAuthToken();
  if (!token) {
    displayError('No authentication token found');
    displayInfo('Run "lain onboard" to set up authentication');
    process.exit(1);
  }

  // Connect to gateway
  displayInfo('Connecting to gateway...');

  const socket = connect(paths.socket);
  let authenticated = false;
  let responseBuffer = '';

  socket.on('connect', () => {
    // Authenticate
    const authMessage: GatewayMessage = {
      id: nanoid(8),
      method: 'auth',
      params: { token },
    };
    socket.write(JSON.stringify(authMessage) + '\n');
  });

  socket.on('data', (data) => {
    responseBuffer += data.toString();
    const lines = responseBuffer.split('\n');
    responseBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as GatewayResponse;
        handleResponse(response);
      } catch {
        displayWarning(`Invalid response: ${line}`);
      }
    }
  });

  socket.on('error', (error) => {
    displayError(`Connection error: ${error.message}`);
    process.exit(1);
  });

  socket.on('close', () => {
    displayInfo('\nDisconnected');
    process.exit(0);
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function handleResponse(response: GatewayResponse): void {
    if (response.error) {
      displayError(`Error: ${response.error.message}`);
      if (response.error.code === -32000) {
        // Unauthorized
        process.exit(1);
      }
      return;
    }

    if (!authenticated) {
      // This should be the auth response
      if (response.result && typeof response.result === 'object' && 'authenticated' in response.result) {
        authenticated = true;
        console.log('\n...connected\n');
        console.log('type your message, or /quit to exit\n');
        promptUser();
      }
      return;
    }

    // Handle chat response
    if (response.result && typeof response.result === 'object' && 'response' in response.result) {
      const chatResult = response.result as { response: string };
      console.log(`\nlain: ${chatResult.response}\n`);
    } else if (response.result && typeof response.result === 'object' && 'echo' in response.result) {
      // Fallback for echo (if agent not available)
      const echo = response.result as { echo: { message: string } };
      if (echo.echo && typeof echo.echo === 'object' && 'message' in echo.echo) {
        console.log(`\nlain: ${echo.echo.message}\n`);
      }
    } else if (response.result) {
      // Generic response
      console.log(`\nlain: ${JSON.stringify(response.result)}\n`);
    }

    promptUser();
  }

  function promptUser(): void {
    rl.question('you: ', (input) => {
      const trimmed = input.trim();

      if (!trimmed) {
        promptUser();
        return;
      }

      if (trimmed === '/quit' || trimmed === '/exit' || trimmed === '/q') {
        socket.end();
        rl.close();
        return;
      }

      if (trimmed === '/help') {
        console.log(`
Commands:
  /quit, /exit, /q  - Exit chat
  /help             - Show this help
  /status           - Check gateway status
`);
        promptUser();
        return;
      }

      if (trimmed === '/status') {
        const statusMessage: GatewayMessage = {
          id: nanoid(8),
          method: 'status',
        };
        socket.write(JSON.stringify(statusMessage) + '\n');
        return;
      }

      // Send chat message to agent
      const message: GatewayMessage = {
        id: nanoid(8),
        method: 'chat',
        params: { message: trimmed },
      };
      socket.write(JSON.stringify(message) + '\n');
    });
  }

  // Handle Ctrl+C
  rl.on('close', () => {
    socket.end();
  });
}

/**
 * Send a single message (non-interactive)
 */
export async function sendMessage(message: string): Promise<void> {
  const paths = getPaths();

  // Check if gateway is running
  const pid = await getServerPid(paths.pidFile);
  if (!pid || !isProcessRunning(pid)) {
    displayError('Gateway is not running');
    process.exit(1);
  }

  // Get auth token
  const token = await getAuthToken();
  if (!token) {
    displayError('No authentication token found');
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const socket = connect(paths.socket);
    let authenticated = false;
    let responseBuffer = '';

    socket.on('connect', () => {
      const authMessage: GatewayMessage = {
        id: nanoid(8),
        method: 'auth',
        params: { token },
      };
      socket.write(JSON.stringify(authMessage) + '\n');
    });

    socket.on('data', (data) => {
      responseBuffer += data.toString();
      const lines = responseBuffer.split('\n');
      responseBuffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const response = JSON.parse(line) as GatewayResponse;

          if (response.error) {
            displayError(`Error: ${response.error.message}`);
            socket.end();
            reject(new Error(response.error.message));
            return;
          }

          if (!authenticated) {
            authenticated = true;
            // Send the actual message
            const msg: GatewayMessage = {
              id: nanoid(8),
              method: 'chat',
              params: { message },
            };
            socket.write(JSON.stringify(msg) + '\n');
            return;
          }

          // Print response and exit
          if (response.result && typeof response.result === 'object' && 'response' in response.result) {
            const chatResult = response.result as { response: string };
            console.log(chatResult.response);
          } else if (response.result && typeof response.result === 'object' && 'echo' in response.result) {
            const echo = response.result as { echo: { message: string } };
            if (echo.echo && typeof echo.echo === 'object' && 'message' in echo.echo) {
              console.log(echo.echo.message);
            }
          }

          socket.end();
          resolve();
        } catch {
          // Ignore parse errors
        }
      }
    });

    socket.on('error', (error) => {
      reject(error);
    });
  });
}
