/**
 * findings.md P2:1757 — per-character, rotated, level-gated debug log files.
 *
 * Previously `agentLog` and `toolLog` each wrote to
 * `${process.cwd()}/logs/{agent,tools}-debug.log` unconditionally — so every
 * character process on the droplet (all cwd-ing into /opt/local-lain/) piled
 * interleaved output into one growing file, making forensics painful and the
 * file unbounded.
 *
 * This helper:
 *   - paths under `${LAIN_HOME}/logs/` so each character isolates its own log
 *   - gates writes by LOG_LEVEL (`debug` or `trace`) — default = no writes
 *   - rotates to `.1` when the active file exceeds 50MB (keep one backup)
 */

import { appendFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getBasePath } from '../config/paths.js';

const MAX_BYTES = 50 * 1024 * 1024;

function isDebugEnabled(): boolean {
  const level = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  return level === 'debug' || level === 'trace';
}

async function rotateIfNeeded(file: string): Promise<void> {
  try {
    const s = await stat(file);
    if (s.size < MAX_BYTES) return;
    const backup = `${file}.1`;
    try { await unlink(backup); } catch { /* no prior backup */ }
    await rename(file, backup);
  } catch {
    // file doesn't exist yet; nothing to rotate
  }
}

export function createDebugLogger(filename: string): (context: string, data: unknown) => Promise<void> {
  const file = join(getBasePath(), 'logs', filename);
  return async (context, data) => {
    if (!isDebugEnabled()) return;
    try {
      await mkdir(dirname(file), { recursive: true });
      await rotateIfNeeded(file);
      const timestamp = new Date().toISOString();
      const entry = `[${timestamp}] [${context}] ${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
      await appendFile(file, entry);
    } catch {
      // debug logging must never crash the request path
    }
  };
}
