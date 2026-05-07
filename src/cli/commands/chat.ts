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
import {
  AuthResultSchema,
  ChatResultSchema,
  EchoResultSchema,
} from '../../gateway/schemas.js';

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
      // findings.md P2:46 / P2:195 — use the zod schema (which requires
      // `authenticated: z.literal(true)`) instead of an ad-hoc `'in'` check.
      // A gateway reply of `{ authenticated: false }` now fails `.safeParse`
      // and drops to the authentication-failed branch.
      if (AuthResultSchema.safeParse(response.result).success) {
        authenticated = true;
        console.log('\n...connected\n');
        console.log('type your message, or /quit to exit\n');
        promptUser();
      } else {
        displayError('authentication failed');
        process.exit(1);
      }
      return;
    }

    // Handle chat response — prefer the ChatResult shape; fall back to
    // EchoResult (returned by `/status` or stub deployments) before the
    // generic JSON dump.
    const chat = ChatResultSchema.safeParse(response.result);
    if (chat.success) {
      console.log(`\nlain: ${chat.data.response}\n`);
    } else {
      const echo = EchoResultSchema.safeParse(response.result);
      const echoInner = echo.success ? echo.data.echo : undefined;
      if (
        echoInner &&
        typeof echoInner === 'object' &&
        'message' in echoInner &&
        typeof (echoInner as { message: unknown }).message === 'string'
      ) {
        console.log(`\nlain: ${(echoInner as { message: string }).message}\n`);
      } else if (response.result !== undefined) {
        console.log(`\nlain: ${JSON.stringify(response.result)}\n`);
      }
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
    let settled = false;

    // findings.md P2:56 — without a timeout + close handler, a gateway that
    // crashes or early-exits after accept() leaves this Promise hanging
    // forever. Guard every resolve/reject with `settled`, clear the timer
    // on exit, and reject if the socket closes before a response arrives.
    const TIMEOUT_MS = Number(process.env['LAIN_CLI_TIMEOUT_MS'] ?? 30_000);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`sendMessage timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);
    timer.unref?.();

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

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
            settle(() => {
              socket.end();
              reject(new Error(response.error!.message));
            });
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

          // findings.md P2:195 — parse the result against the same schema
          // the router validates outputs against, instead of ad-hoc `'in'`
          // checks that silently accept the wrong shape.
          const chat = ChatResultSchema.safeParse(response.result);
          if (chat.success) {
            console.log(chat.data.response);
          } else {
            const echoParsed = EchoResultSchema.safeParse(response.result);
            const echoInner = echoParsed.success ? echoParsed.data.echo : undefined;
            if (
              echoInner &&
              typeof echoInner === 'object' &&
              'message' in echoInner &&
              typeof (echoInner as { message: unknown }).message === 'string'
            ) {
              console.log((echoInner as { message: string }).message);
            }
          }

          settle(() => {
            socket.end();
            resolve();
          });
        } catch {
          // Ignore parse errors
        }
      }
    });

    socket.on('error', (error) => {
      settle(() => reject(error));
    });

    socket.on('close', () => {
      settle(() =>
        reject(new Error('gateway closed the connection before a response was received')),
      );
    });
  });
}
