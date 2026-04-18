/**
 * Session storage operations
 */

import { nanoid } from 'nanoid';
import { execute, query, queryOne, transaction } from './database.js';
import type {
  Session,
  SessionCreateInput,
  SessionUpdateInput,
  SessionFlags,
} from '../types/session.js';

interface SessionRow {
  key: string;
  agent_id: string;
  channel: string;
  peer_kind: string;
  peer_id: string;
  created_at: number;
  updated_at: number;
  token_count: number;
  transcript_path: string | null;
  flags: string;
}

function rowToSession(row: SessionRow): Session {
  const session: Session = {
    key: row.key,
    agentId: row.agent_id,
    channel: row.channel as Session['channel'],
    peerKind: row.peer_kind as Session['peerKind'],
    peerId: row.peer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tokenCount: row.token_count,
    flags: JSON.parse(row.flags) as SessionFlags,
  };
  if (row.transcript_path !== null) {
    session.transcriptPath = row.transcript_path;
  }
  return session;
}

/**
 * Generate a unique session key
 */
export function generateSessionKey(): string {
  return nanoid(21);
}

/**
 * Create a new session
 */
export function createSession(input: SessionCreateInput): Session {
  const now = Date.now();
  const key = generateSessionKey();

  const session: Session = {
    key,
    agentId: input.agentId,
    channel: input.channel,
    peerKind: input.peerKind,
    peerId: input.peerId,
    createdAt: now,
    updatedAt: now,
    tokenCount: 0,
    flags: {},
  };

  execute(
    `INSERT INTO sessions (key, agent_id, channel, peer_kind, peer_id, created_at, updated_at, token_count, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.key,
      session.agentId,
      session.channel,
      session.peerKind,
      session.peerId,
      session.createdAt,
      session.updatedAt,
      session.tokenCount,
      JSON.stringify(session.flags),
    ]
  );

  return session;
}

/**
 * Get a session by key
 */
export function getSession(key: string): Session | undefined {
  const row = queryOne<SessionRow>('SELECT * FROM sessions WHERE key = ?', [key]);
  return row ? rowToSession(row) : undefined;
}

/**
 * Find a session by channel and peer
 */
export function findSession(
  agentId: string,
  channel: string,
  peerId: string
): Session | undefined {
  const row = queryOne<SessionRow>(
    'SELECT * FROM sessions WHERE agent_id = ? AND channel = ? AND peer_id = ? ORDER BY updated_at DESC LIMIT 1',
    [agentId, channel, peerId]
  );
  return row ? rowToSession(row) : undefined;
}

/**
 * Get or create a session for a given agent/channel/peer combination
 */
export function getOrCreateSession(input: SessionCreateInput): Session {
  return transaction(() => {
    const existing = findSession(input.agentId, input.channel, input.peerId);
    if (existing) {
      return existing;
    }
    return createSession(input);
  });
}

/**
 * Update a session
 */
export function updateSession(key: string, updates: SessionUpdateInput): Session | undefined {
  const session = getSession(key);
  if (!session) {
    return undefined;
  }

  const now = Date.now();
  const newFlags = updates.flags ? { ...session.flags, ...updates.flags } : session.flags;

  execute(
    `UPDATE sessions SET
      token_count = ?,
      transcript_path = ?,
      flags = ?,
      updated_at = ?
     WHERE key = ?`,
    [
      updates.tokenCount ?? session.tokenCount,
      updates.transcriptPath ?? session.transcriptPath ?? null,
      JSON.stringify(newFlags),
      now,
      key,
    ]
  );

  return getSession(key);
}

/**
 * Delete a session
 */
export function deleteSession(key: string): boolean {
  const result = execute('DELETE FROM sessions WHERE key = ?', [key]);
  return result.changes > 0;
}

/**
 * List sessions for an agent
 */
export function listSessions(
  agentId: string,
  options?: { channel?: string; limit?: number; offset?: number }
): Session[] {
  let sql = 'SELECT * FROM sessions WHERE agent_id = ?';
  const params: unknown[] = [agentId];

  if (options?.channel) {
    sql += ' AND channel = ?';
    params.push(options.channel);
  }

  sql += ' ORDER BY updated_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = query<SessionRow>(sql, params);
  return rows.map(rowToSession);
}

/**
 * Count sessions for an agent
 */
export function countSessions(agentId: string, channel?: string): number {
  let sql = 'SELECT COUNT(*) as count FROM sessions WHERE agent_id = ?';
  const params: unknown[] = [agentId];

  if (channel) {
    sql += ' AND channel = ?';
    params.push(channel);
  }

  const result = queryOne<{ count: number }>(sql, params);
  return result?.count ?? 0;
}

/**
 * Delete old sessions (cleanup)
 */
export function deleteOldSessions(agentId: string, maxAge: number): number {
  const cutoff = Date.now() - maxAge;
  const result = execute(
    'DELETE FROM sessions WHERE agent_id = ? AND updated_at < ?',
    [agentId, cutoff]
  );
  return result.changes;
}

/**
 * Batch update token counts
 */
export function batchUpdateTokenCounts(
  updates: Array<{ key: string; tokenCount: number }>
): void {
  transaction(() => {
    for (const update of updates) {
      execute(
        'UPDATE sessions SET token_count = ?, updated_at = ? WHERE key = ?',
        [update.tokenCount, Date.now(), update.key]
      );
    }
  });
}
