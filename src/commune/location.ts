/**
 * Commune Town — Location state management.
 * Persists character locations via the meta key-value store
 * and emits movement events through the event bus.
 */

import { getMeta, setMeta, transaction } from '../storage/database.js';
import { eventBus } from '../events/bus.js';
import { DEFAULT_LOCATIONS, BUILDING_MAP, type BuildingId } from './buildings.js';
import { getLogger } from '../utils/logger.js';

interface LocationRecord {
  building: string;
  timestamp: number;
}

interface LocationHistoryEntry {
  from: string;
  to: string;
  reason: string;
  timestamp: number;
}

const MAX_HISTORY = 20;

/**
 * Get the current location for a character in the current process.
 *
 * findings.md P2:1386 — the `characterId` parameter is a DEFAULT-FALLBACK
 * HINT ONLY. The meta lookup is always process-scoped: each character
 * runs in its own process with its own DB, and `getMeta` always reads
 * from that DB. Passing a different character's id does NOT query that
 * character's state — it just picks which DEFAULT_LOCATIONS entry to
 * use if nothing is persisted yet. To query a peer's location, call
 * their `/api/location` endpoint instead.
 *
 * When `characterId` disagrees with `eventBus.characterId`, emit a
 * WARN so misuse ("I'll call getCurrentLocation('pkd') from Wired
 * Lain's process to see PKD's location") becomes visible instead of
 * silently returning Wired Lain's meta with PKD's default.
 */
export function getCurrentLocation(characterId?: string): LocationRecord {
  const charId = characterId || eventBus.characterId || '';
  if (characterId && eventBus.characterId && characterId !== eventBus.characterId) {
    getLogger().warn(
      { requested: characterId, processCharacter: eventBus.characterId },
      'getCurrentLocation called with a peer characterId — this function is process-local; use the peer /api/location endpoint for cross-character queries'
    );
  }

  try {
    const raw = getMeta('town:current_location');
    if (raw) {
      const record = JSON.parse(raw) as LocationRecord;
      if (record.building && BUILDING_MAP.has(record.building)) {
        return record;
      }
    }
  } catch {
    // Fall through to default
  }

  // findings.md P2:1402 — return timestamp:0 for the un-persisted
  // fallback rather than Date.now(). Consumers that read
  // `.timestamp` as "how long have you been at this building"
  // previously saw an ever-incrementing value for first-run
  // characters, because every call minted a fresh Date.now().
  // timestamp:0 is a clear sentinel: "no persisted record yet".
  const defaultBuilding = DEFAULT_LOCATIONS[charId] || 'lighthouse';
  return { building: defaultBuilding, timestamp: 0 };
}

/**
 * Set the current location, append to history, and emit a movement event.
 * No-op if from === to (staying in place).
 *
 * findings.md P2:1418 — the three meta reads/writes (current_location
 * read, current_location write, history RMW) now run inside a single
 * SQLite transaction. Previously two concurrent moves (e.g. desires.ts
 * and town-life.ts firing at once) could race: both read the same
 * `from`, both unshift their own entry on the same base history, and
 * the second write clobbered the first — leaving history entries
 * claiming impossible transitions and losing moves. A transaction
 * serializes them and recovers atomicity on crash.
 */
export function setCurrentLocation(building: BuildingId, reason: string): void {
  let from = building;
  let skipped = true;
  let now = 0;

  transaction(() => {
    const current = getCurrentLocation();
    from = current.building;

    // No-op if staying in place — abort inside the transaction
    if (from === building) {
      skipped = true;
      return;
    }
    skipped = false;
    now = Date.now();

    const record: LocationRecord = { building, timestamp: now };
    setMeta('town:current_location', JSON.stringify(record));

    // History RMW — inside the same transaction so two concurrent
    // moves can't both read the same base history and clobber.
    const history = getLocationHistory(MAX_HISTORY);
    history.unshift({ from, to: building, reason, timestamp: now });
    const capped = history.slice(0, MAX_HISTORY);
    setMeta('town:location_history', JSON.stringify(capped));
  });

  if (skipped) return;

  // Side effects run outside the transaction: event emission and
  // cross-process POSTs shouldn't hold the DB lock, and rolling them
  // back on SQLite retry would double-emit the movement event.
  const fromName = BUILDING_MAP.get(from)?.name || from;
  const toName = BUILDING_MAP.get(building)?.name || building;

  eventBus.emitActivity({
    type: 'movement',
    sessionKey: `movement:${from}:${building}`,
    content: `moved from ${fromName} to ${toName} — ${reason}`,
    timestamp: now,
  });

  // Record building events for spatial residue.
  // findings.md P2:1434 — previously this had three silent catches
  // stacked (outer dynamic-import + two per-call). Every failure mode
  // (Wired Lain unreachable, import boot failure, recordBuildingEvent
  // rejection) produced identical "looks fine" behavior, so spatial
  // residue could be broken for weeks with zero signal. Log WARN on
  // each branch so the operator at least sees it.
  const charId = eventBus.characterId || 'unknown';
  const log = getLogger();
  import('./building-memory.js').then(({ recordBuildingEvent }) => {
    recordBuildingEvent({
      building: from,
      event_type: 'departure',
      summary: `${charId} left for ${toName}`,
      emotional_tone: 0,
      actors: [charId],
    }).catch((err) => {
      log.warn({ err, building: from, characterId: charId, event_type: 'departure' }, 'building-memory: failed to record departure');
    });
    recordBuildingEvent({
      building,
      event_type: 'arrival',
      summary: `${charId} arrived — ${reason}`,
      emotional_tone: 0,
      actors: [charId],
    }).catch((err) => {
      log.warn({ err, building, characterId: charId, event_type: 'arrival' }, 'building-memory: failed to record arrival');
    });
  }).catch((err) => {
    log.warn({ err }, 'building-memory: dynamic import failed — spatial residue writes disabled for this move');
  });
}

/**
 * Get recent location history entries.
 */
export function getLocationHistory(limit = 20): LocationHistoryEntry[] {
  try {
    const raw = getMeta('town:location_history');
    if (!raw) return [];
    const entries = JSON.parse(raw) as LocationHistoryEntry[];
    return entries.slice(0, limit);
  } catch {
    return [];
  }
}
