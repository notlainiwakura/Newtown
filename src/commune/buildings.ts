/**
 * Newtown grid definitions for the 3x3 town layout.
 */

export interface Building {
  id: string;
  name: string;
  emoji: string;
  row: number;
  col: number;
  description: string;
}

export const BUILDINGS: readonly Building[] = [
  { id: 'pub', name: 'Pub', emoji: '🍺', row: 0, col: 0, description: 'conversation, familiarity, late-night arguments' },
  { id: 'station', name: 'Station', emoji: '🚉', row: 0, col: 1, description: 'arrivals, departures, crossing paths' },
  { id: 'abandoned-house', name: 'Abandoned House', emoji: '🏚️', row: 0, col: 2, description: 'dust, memory, things left behind' },
  { id: 'field', name: 'Field', emoji: '🌾', row: 1, col: 0, description: 'distance, quiet, weather moving through' },
  { id: 'windmill', name: 'Windmill', emoji: '🏚', row: 1, col: 1, description: 'turning cycles, work, repetition' },
  { id: 'locksmith', name: 'Locksmith', emoji: '🔐', row: 1, col: 2, description: 'access, hidden compartments, practical mysteries' },
  { id: 'mystery-tower', name: 'Mystery Tower', emoji: '🗼', row: 2, col: 0, description: 'height, signal, unfinished questions' },
  { id: 'theater', name: 'Theater', emoji: '🎭', row: 2, col: 1, description: 'performance, masks, public emotion' },
  { id: 'square', name: 'Square', emoji: '⬜', row: 2, col: 2, description: 'meeting place, ordinary daylight, civic rhythm' },
] as const;

export type BuildingId = typeof BUILDINGS[number]['id'];

export const BUILDING_MAP = new Map<string, Building>(
  BUILDINGS.map((building) => [building.id, building])
);

export const DEFAULT_LOCATIONS: Record<string, BuildingId> = {
  neo: 'station',
  plato: 'mystery-tower',
  joe: 'square',
};

export function isValidBuilding(id: string): id is BuildingId {
  return BUILDING_MAP.has(id);
}
