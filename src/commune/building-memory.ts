/**
 * Building Memory — spatial residue system.
 *
 * Buildings accumulate traces of what happens in them: conversations,
 * arrivals, objects left behind, quiet moments. Characters sense these
 * traces when present, making the spatial grid a living space.
 *
 * Events are stored centrally on Wired Lain's database. Characters
 * record events via POST and read residue via GET.
 */

import { nanoid } from 'nanoid';
import { getLogger } from '../utils/logger.js';
import { getCurrentLocation } from './location.js';
import { BUILDING_MAP } from './buildings.js';

const WIRED_LAIN_URL = process.env['WIRED_LAIN_URL'] || 'http://localhost:3000';
const INTERLINK_TOKEN = process.env['LAIN_INTERLINK_TOKEN'] || '';

export interface BuildingEvent {
  id: string;
  building: string;
  event_type: 'conversation' | 'arrival' | 'departure' | 'note_left' | 'object_placed' | 'object_taken' | 'quiet_moment';
  summary: string;
  emotional_tone: number; // -1.0 to 1.0
  actors: string[];       // character IDs
  created_at: number;
}

/**
 * Record a building event by POSTing to Wired Lain's API.
 * Fire-and-forget — failures are silently ignored.
 */
export async function recordBuildingEvent(event: Omit<BuildingEvent, 'id' | 'created_at'>): Promise<void> {
  try {
    await fetch(`${WIRED_LAIN_URL}/api/buildings/${encodeURIComponent(event.building)}/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${INTERLINK_TOKEN}`,
      },
      body: JSON.stringify({
        id: nanoid(16),
        ...event,
        created_at: Date.now(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-critical — building memory is best-effort
  }
}

/** Raw event from the API */
interface RawBuildingEvent {
  id: string;
  building: string;
  event_type: string;
  summary: string;
  emotional_tone: number;
  actors: string[];
  created_at: number;
}

/**
 * Fetch recent building residue from Wired Lain's API.
 */
async function getBuildingResidue(building: string, hours = 24): Promise<RawBuildingEvent[]> {
  try {
    const resp = await fetch(
      `${WIRED_LAIN_URL}/api/buildings/${encodeURIComponent(building)}/residue?hours=${hours}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return [];
    return await resp.json() as RawBuildingEvent[];
  } catch {
    return [];
  }
}

/**
 * Build a prompt context section describing the atmosphere of the character's
 * current building. Returns empty string if no residue or on error.
 *
 * Token budget: ~300-500 tokens max.
 */
export async function buildBuildingResidueContext(characterId: string): Promise<string> {
  const logger = getLogger();

  try {
    const loc = getCurrentLocation(characterId);
    const building = BUILDING_MAP.get(loc.building);
    if (!building) return '';

    const events = await getBuildingResidue(loc.building, 24);
    if (events.length === 0) return '';

    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const SIX_HOURS = 6 * ONE_HOUR;

    // Categorize by freshness
    const vivid: RawBuildingEvent[] = [];   // < 1h
    const fading: RawBuildingEvent[] = [];  // 1-6h
    const echoes: RawBuildingEvent[] = [];  // 6-24h

    for (const e of events) {
      // Skip events involving this character (don't sense your own residue)
      if (e.actors.includes(characterId)) continue;

      const age = now - e.created_at;
      if (age < ONE_HOUR) vivid.push(e);
      else if (age < SIX_HOURS) fading.push(e);
      else echoes.push(e);
    }

    // Cap entries to stay within token budget
    const lines: string[] = [];
    for (const e of vivid.slice(0, 3)) {
      lines.push(`[Vivid — just now] ${e.summary}`);
    }
    for (const e of fading.slice(0, 2)) {
      lines.push(`[Fading — a few hours ago] ${e.summary}`);
    }
    for (const e of echoes.slice(0, 1)) {
      lines.push(`[Echo — yesterday] ${e.summary}`);
    }

    if (lines.length === 0) return '';

    return '\n\n---\n\n## The Atmosphere Here\n\n' +
      `You are at the ${building.name}. You sense traces of what has happened in this place recently.\n\n` +
      lines.join('\n');
  } catch (err) {
    logger.debug({ err }, 'Failed to build building residue context');
    return '';
  }
}

/**
 * Store a building event directly in the local database (for Wired Lain's server).
 */
export function storeBuildingEventLocal(
  db: import('better-sqlite3').Database,
  event: BuildingEvent
): void {
  db.prepare(
    `INSERT OR IGNORE INTO building_events (id, building, event_type, summary, emotional_tone, actors, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.id,
    event.building,
    event.event_type,
    event.summary,
    event.emotional_tone,
    JSON.stringify(event.actors),
    event.created_at
  );
}

/**
 * Query building events from the local database (for Wired Lain's server).
 */
export function queryBuildingEvents(
  db: import('better-sqlite3').Database,
  building: string,
  hours = 24
): BuildingEvent[] {
  const since = Date.now() - hours * 60 * 60 * 1000;

  // Prune old events (> 48h) lazily
  const pruneThreshold = Date.now() - 48 * 60 * 60 * 1000;
  db.prepare('DELETE FROM building_events WHERE created_at < ?').run(pruneThreshold);

  const rows = db.prepare(
    `SELECT id, building, event_type, summary, emotional_tone, actors, created_at
     FROM building_events
     WHERE building = ? AND created_at > ?
     ORDER BY created_at DESC
     LIMIT 20`
  ).all(building, since) as Array<{
    id: string;
    building: string;
    event_type: string;
    summary: string;
    emotional_tone: number;
    actors: string;
    created_at: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    building: r.building,
    event_type: r.event_type as BuildingEvent['event_type'],
    summary: r.summary,
    emotional_tone: r.emotional_tone,
    actors: JSON.parse(r.actors) as string[],
    created_at: r.created_at,
  }));
}
