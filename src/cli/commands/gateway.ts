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
import { getAllCharacters, getAgentConfigFor } from '../../config/characters.js';

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

    // findings.md P2:171 — gateway serves a single character. Resolution:
    //   1. `LAIN_GATEWAY_AGENT_ID` env var (explicit override)
    //   2. First character from characters.json
    // Agent runtime is single-tenant (see agent/index.ts:167-176), so the
    // legacy iteration of `config.agents` never initialized more than one.
    displayInfo('Initializing agent...');
    const gatewayAgentId =
      process.env['LAIN_GATEWAY_AGENT_ID'] ?? getAllCharacters()[0]?.id;
    if (!gatewayAgentId) {
      displayError(
        'No characters.json entry available and LAIN_GATEWAY_AGENT_ID is unset — gateway has nothing to serve.',
      );
      process.exit(1);
    }
    const agentConfig = getAgentConfigFor(gatewayAgentId);
    await initAgent(agentConfig);
    logger.info({ agentId: agentConfig.id }, 'Agent initialized');

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

    // findings.md P2:115 — cold-boot races. First DB init, keychain
    // unlock prompts, and slow disks can push daemon startup past a
    // fixed 1 s wait. Poll the pid file on a short interval until the
    // daemon is observed, or until a hard deadline elapses.
    const DAEMON_STARTUP_TIMEOUT_MS = Number(
      process.env['LAIN_DAEMON_STARTUP_TIMEOUT_MS'] ?? 10_000,
    );
    const POLL_INTERVAL_MS = 200;
    const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;

    let pid: number | null = null;
    while (Date.now() < deadline) {
      const found = await getServerPid(paths.pidFile);
      if (found && isProcessRunning(found)) {
        pid = found;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (pid !== null) {
      displaySuccess(`Gateway daemon started (PID: ${pid})`);
    } else {
      displayError(`Failed to start daemon (no pid after ${DAEMON_STARTUP_TIMEOUT_MS}ms)`);
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
