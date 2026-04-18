/**
 * Possession State Machine — Manages player possession of a character.
 *
 * Single-player, in-process state only (no persistence across restarts).
 * When possessed: background loops stop, peer messages queue for player response.
 * When released: loops restart, pending messages auto-resolve with "...".
 */

import { secureCompare } from '../utils/crypto.js';

export interface PendingPeerMessage {
  fromId: string;
  fromName: string;
  message: string;
  timestamp: number;
  resolve: (response: string) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

interface PossessionState {
  isPossessed: boolean;
  possessedAt: number | null;
  lastActivityAt: number | null;
  playerSessionId: string | null;
  loopRestarters: (() => (() => void))[];
  activeLoopStops: (() => void)[];
  pendingPeerMessages: PendingPeerMessage[];
  sseClients: Set<import('node:http').ServerResponse>;
  idleTimer: ReturnType<typeof setInterval> | null;
}

const state: PossessionState = {
  isPossessed: false,
  possessedAt: null,
  lastActivityAt: null,
  playerSessionId: null,
  loopRestarters: [],
  activeLoopStops: [],
  pendingPeerMessages: [],
  sseClients: new Set(),
  idleTimer: null,
};

const PENDING_TIMEOUT_MS = 60_000; // 60s auto-timeout for pending messages
const IDLE_TIMEOUT_MS = 5 * 60_000; // 5 min idle → auto-unpossess
const IDLE_CHECK_INTERVAL_MS = 30_000; // check every 30s

export function isPossessed(): boolean {
  return state.isPossessed;
}

/**
 * Mark player activity — resets the idle timeout.
 * Call this on any player action (say, move, look, reply, etc.).
 */
export function touchActivity(): void {
  state.lastActivityAt = Date.now();
}

function startIdleTimer(): void {
  stopIdleTimer();
  state.idleTimer = setInterval(() => {
    if (!state.isPossessed || !state.lastActivityAt) return;
    if (Date.now() - state.lastActivityAt > IDLE_TIMEOUT_MS) {
      console.log(`[Possession] Idle timeout (${IDLE_TIMEOUT_MS / 60000}min) — auto-releasing`);
      endPossession();
    }
  }, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleTimer(): void {
  if (state.idleTimer) {
    clearInterval(state.idleTimer);
    state.idleTimer = null;
  }
}

export function getPossessionState() {
  return {
    isPossessed: state.isPossessed,
    possessedAt: state.possessedAt,
    playerSessionId: state.playerSessionId,
    pendingCount: state.pendingPeerMessages.length,
  };
}

/**
 * Start possession: stop all background loops, set possessed state.
 */
export function startPossession(
  playerSessionId: string,
  loopStops: (() => void)[],
  loopRestarters: (() => (() => void))[]
): void {
  if (state.isPossessed) return;

  // Stop all background loops
  for (const stop of loopStops) {
    stop();
  }

  state.isPossessed = true;
  state.possessedAt = Date.now();
  state.lastActivityAt = Date.now();
  state.playerSessionId = playerSessionId;
  state.loopRestarters = loopRestarters;
  state.activeLoopStops = [];

  startIdleTimer();
  console.log(`[Possession] Started — player session: ${playerSessionId}`);
}

/**
 * End possession: reject pending messages with "...", restart all loops.
 */
export function endPossession(): void {
  if (!state.isPossessed) return;

  // Resolve all pending messages with "..."
  for (const pending of state.pendingPeerMessages) {
    clearTimeout(pending.timeoutHandle);
    pending.resolve('...');
  }
  state.pendingPeerMessages = [];

  // Restart all background loops
  const newStops: (() => void)[] = [];
  for (const restarter of state.loopRestarters) {
    const stop = restarter();
    newStops.push(stop);
  }
  state.activeLoopStops = newStops;

  stopIdleTimer();
  state.isPossessed = false;
  state.possessedAt = null;
  state.lastActivityAt = null;
  state.playerSessionId = null;
  state.loopRestarters = [];

  // Notify SSE clients
  broadcastSSE({ type: 'possession_ended' });

  console.log('[Possession] Ended — loops restarted');
}

/**
 * Queue a peer message for the player to respond to.
 * Returns a Promise that resolves with the response string.
 */
export function addPendingPeerMessage(
  fromId: string,
  fromName: string,
  message: string
): Promise<string> {
  return new Promise((resolve) => {
    const timeoutHandle = setTimeout(() => {
      // Auto-timeout: respond with "..." and remove from queue
      removePendingMessage(fromId);
      resolve('...');
    }, PENDING_TIMEOUT_MS);

    const pending: PendingPeerMessage = {
      fromId,
      fromName,
      message,
      timestamp: Date.now(),
      resolve,
      timeoutHandle,
    };

    state.pendingPeerMessages.push(pending);

    // Notify SSE clients about new pending message
    broadcastSSE({
      type: 'peer_message',
      fromId,
      fromName,
      message,
      timestamp: pending.timestamp,
    });
  });
}

/**
 * Get all pending peer messages (without resolve/timeout internals).
 */
export function getPendingPeerMessages() {
  return state.pendingPeerMessages.map((p) => ({
    fromId: p.fromId,
    fromName: p.fromName,
    message: p.message,
    timestamp: p.timestamp,
  }));
}

/**
 * Resolve a pending peer message with the player's response.
 * Returns true if a matching message was found and resolved.
 */
export function resolvePendingMessage(fromId: string, response: string): boolean {
  const idx = state.pendingPeerMessages.findIndex((p) => p.fromId === fromId);
  if (idx === -1) return false;

  const pending = state.pendingPeerMessages[idx]!;
  clearTimeout(pending.timeoutHandle);
  state.pendingPeerMessages.splice(idx, 1);
  pending.resolve(response);
  return true;
}

function removePendingMessage(fromId: string): void {
  const idx = state.pendingPeerMessages.findIndex((p) => p.fromId === fromId);
  if (idx !== -1) {
    state.pendingPeerMessages.splice(idx, 1);
  }
}

/**
 * Verify possession auth token from Authorization header.
 */
export function verifyPossessionAuth(authHeader: string | undefined): boolean {
  const token = process.env['POSSESSION_TOKEN'];
  if (!token) return false;

  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;

  return secureCompare(authHeader.slice('Bearer '.length), token);
}

// --- SSE for possession stream ---

export function addSSEClient(res: import('node:http').ServerResponse): void {
  state.sseClients.add(res);
}

export function removeSSEClient(res: import('node:http').ServerResponse): void {
  state.sseClients.delete(res);
}

function broadcastSSE(data: Record<string, unknown>): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of state.sseClients) {
    try {
      client.write(payload);
    } catch {
      state.sseClients.delete(client);
    }
  }
}

export function broadcastMovement(building: string): void {
  broadcastSSE({ type: 'movement', building, timestamp: Date.now() });
}

/**
 * Get the current active loop stop functions (for shutdown).
 */
export function getActiveLoopStops(): (() => void)[] {
  return state.activeLoopStops;
}
