/**
 * Gateway command - Start/stop the gateway server
 */

import { spawn } from 'node:child_process';
import { loadConfig, getPaths } from '../../config/index.js';
import {
  startServer,
  stopServer,
  getServerPid,
  isProcessRunning,
} from '../../gateway/server.js';
import { initDatabase, closeDatabase } from '../../storage/database.js';
import { createLogger, getLogger } from '../../utils/logger.js';
import {
  displaySuccess,
  displayError,
  displayInfo,
  displayWarning,
} from '../utils/prompts.js';
import { initAgent, shutdownAgents } from '../../agent/index.js';
import { registerChatMethod } from '../../gateway/router.js';

/**
 * Start the gateway in foreground mode
 */
export async function startGateway(): Promise<void> {
  try {
    // Load configuration
    const config = await loadConfig();

    // Initialize logger
    createLogger(config.logging);
    const logger = getLogger();

    // Check if already running
    const paths = getPaths();
    const existingPid = await getServerPid(paths.pidFile);
    if (existingPid && isProcessRunning(existingPid)) {
      displayError(`Gateway already running (PID: ${existingPid})`);
      process.exit(1);
    }

    // Initialize database
    await initDatabase(paths.database, config.security.keyDerivation);

    // Initialize agents
    displayInfo('Initializing agents...');
    for (const agentConfig of config.agents) {
      await initAgent(agentConfig);
      logger.info({ agentId: agentConfig.id }, 'Agent initialized');
    }

    // Register chat method
    registerChatMethod();

    displayInfo('Starting gateway...');

    // Start server
    await startServer(config.gateway, {
      requireAuth: config.security.requireAuth,
      maxMessageLength: config.security.maxMessageLength,
    });

    displaySuccess(`Gateway listening on ${config.gateway.socketPath}`);

    // Handle shutdown signals
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');
      displayInfo(`\nShutting down (${signal})...`);

      await stopServer();
      shutdownAgents();
      closeDatabase();

      displaySuccess('Gateway stopped');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Keep process running
    logger.info('Gateway running, press Ctrl+C to stop');
  } catch (error) {
    displayError(`Failed to start gateway: ${error}`);
    process.exit(1);
  }
}

/**
 * Start the gateway as a daemon
 */
export async function startDaemon(): Promise<void> {
  try {
    // Check if already running
    const paths = getPaths();
    const existingPid = await getServerPid(paths.pidFile);
    if (existingPid && isProcessRunning(existingPid)) {
      displayError(`Gateway already running (PID: ${existingPid})`);
      process.exit(1);
    }

    displayInfo('Starting gateway daemon...');

    // Spawn detached process
    const child = spawn(process.execPath, [process.argv[1]!, 'gateway'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LAIN_DAEMON: '1' },
    });

    child.unref();

    // Wait a moment and check if it started
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const pid = await getServerPid(paths.pidFile);
    if (pid && isProcessRunning(pid)) {
      displaySuccess(`Gateway daemon started (PID: ${pid})`);
    } else {
      displayError('Failed to start daemon');
      process.exit(1);
    }
  } catch (error) {
    displayError(`Failed to start daemon: ${error}`);
    process.exit(1);
  }
}

/**
 * Stop the gateway daemon
 */
export async function stopGateway(): Promise<void> {
  try {
    const paths = getPaths();
    const pid = await getServerPid(paths.pidFile);

    if (!pid) {
      displayWarning('Gateway is not running');
      return;
    }

    if (!isProcessRunning(pid)) {
      displayWarning('Gateway process not found, cleaning up...');
      return;
    }

    displayInfo(`Stopping gateway (PID: ${pid})...`);

    // Send SIGTERM
    process.kill(pid, 'SIGTERM');

    // Wait for process to stop
    let attempts = 0;
    while (attempts < 10) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!isProcessRunning(pid)) {
        break;
      }
      attempts++;
    }

    if (isProcessRunning(pid)) {
      displayWarning('Process did not stop gracefully, sending SIGKILL');
      process.kill(pid, 'SIGKILL');
    }

    displaySuccess('Gateway stopped');
  } catch (error) {
    displayError(`Failed to stop gateway: ${error}`);
    process.exit(1);
  }
}
