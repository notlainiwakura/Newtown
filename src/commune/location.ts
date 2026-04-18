/**
 * Town location state management.
 * Persists each resident's location separately via the meta store
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

function currentLocationKey(characterId: string): string {
  return `town:${characterId}:current_location`;
}

function locationHistoryKey(characterId: string): string {
  return `town:${characterId}:location_history`;
}

/**
 * Get the current location for a resident.
 * Falls back to DEFAULT_LOCATIONS if nothing is persisted.
 */
export function getCurrentLocation(characterId?: string): LocationRecord {
  const charId = characterId || eventBus.characterId || 'default';

  try {
    const raw = getMeta(currentLocationKey(charId));
    if (raw) {
      const record = JSON.parse(raw) as LocationRecord;
      if (record.building && BUILDING_MAP.has(record.building)) {
        return record;
      }
    }
  } catch {
    // Fall through to default.
  }

  const defaultBuilding = DEFAULT_LOCATIONS[charId] || 'square';
  return { building: defaultBuilding, timestamp: Date.now() };
}

/**
 * Set the current location, append to history, and emit a movement event.
 * No-op if from === to.
 */
export function setCurrentLocation(building: BuildingId, reason: string): void {
  const charId = eventBus.characterId || 'default';
  const current = getCurrentLocation(charId);
  const from = current.building;

  if (from === building) return;

  const now = Date.now();

  const record: LocationRecord = { building, timestamp: now };
  setMeta(currentLocationKey(charId), JSON.stringify(record));

  const history = getLocationHistory(MAX_HISTORY, charId);
  history.unshift({ from, to: building, reason, timestamp: now });
  setMeta(locationHistoryKey(charId), JSON.stringify(history.slice(0, MAX_HISTORY)));

  const fromName = BUILDING_MAP.get(from)?.name || from;
  const toName = BUILDING_MAP.get(building)?.name || building;

  eventBus.emitActivity({
    type: 'movement',
    sessionKey: `movement:${charId}:${from}:${building}`,
    content: `moved from ${fromName} to ${toName} - ${reason}`,
    timestamp: now,
  });
}

/**
 * Get recent location history entries.
 */
export function getLocationHistory(limit = 20, characterId?: string): LocationHistoryEntry[] {
  const charId = characterId || eventBus.characterId || 'default';

  try {
    const raw = getMeta(locationHistoryKey(charId));
    if (!raw) return [];
    const entries = JSON.parse(raw) as LocationHistoryEntry[];
    return entries.slice(0, limit);
  } catch {
    return [];
  }
}
