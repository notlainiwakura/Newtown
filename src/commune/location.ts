/**
 * Commune Town — Location state management.
 * Persists character locations via the meta key-value store
 * and emits movement events through the event bus.
 */

import { getMeta, setMeta } from '../storage/database.js';
import { eventBus } from '../events/bus.js';
import { DEFAULT_LOCATIONS, BUILDING_MAP, type BuildingId } from './buildings.js';

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
 * Get the current location for a character.
 * Falls back to DEFAULT_LOCATIONS if nothing is persisted.
 */
export function getCurrentLocation(characterId?: string): LocationRecord {
  const charId = characterId || eventBus.characterId;

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

  const defaultBuilding = DEFAULT_LOCATIONS[charId] || 'square';
  return { building: defaultBuilding, timestamp: Date.now() };
}

/**
 * Set the current location, append to history, and emit a movement event.
 * No-op if from === to (staying in place).
 */
export function setCurrentLocation(building: BuildingId, reason: string): void {
  const current = getCurrentLocation();
  const from = current.building;

  // No-op if staying in place
  if (from === building) return;

  const now = Date.now();

  // Update current location
  const record: LocationRecord = { building, timestamp: now };
  setMeta('town:current_location', JSON.stringify(record));

  // Append to history
  const history = getLocationHistory(MAX_HISTORY);
  history.unshift({ from, to: building, reason, timestamp: now });
  const capped = history.slice(0, MAX_HISTORY);
  setMeta('town:location_history', JSON.stringify(capped));

  // Emit movement event
  const fromName = BUILDING_MAP.get(from)?.name || from;
  const toName = BUILDING_MAP.get(building)?.name || building;

  eventBus.emitActivity({
    type: 'movement',
    sessionKey: `movement:${from}:${building}`,
    content: `moved from ${fromName} to ${toName} — ${reason}`,
    timestamp: now,
  });

  // Record building events for spatial residue
  const charId = eventBus.characterId || 'unknown';
  import('./building-memory.js').then(({ recordBuildingEvent }) => {
    recordBuildingEvent({
      building: from,
      event_type: 'departure',
      summary: `${charId} left for ${toName}`,
      emotional_tone: 0,
      actors: [charId],
    }).catch(() => {});
    recordBuildingEvent({
      building,
      event_type: 'arrival',
      summary: `${charId} arrived — ${reason}`,
      emotional_tone: 0,
      actors: [charId],
    }).catch(() => {});
  }).catch(() => {});
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
