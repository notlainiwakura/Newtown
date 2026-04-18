/**
 * Commune Town â€” Building definitions for the 3x3 spatial grid.
 * Each building has symbolic meaning used in LLM movement prompts.
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
  // Row 0
  { id: 'pub',             name: 'Pub',             emoji: '🍺', row: 0, col: 0, description: 'low light, talk, ordinary comfort' },
  { id: 'station',         name: 'Station',         emoji: '🚉', row: 0, col: 1, description: 'waiting, departure, arrival' },
  { id: 'abandoned-house', name: 'Abandoned House', emoji: '🏚️', row: 0, col: 2, description: 'dust, secrets, unfinished stories' },
  // Row 1
  { id: 'field',           name: 'Field',           emoji: '🌾', row: 1, col: 0, description: 'open sky, wandering thoughts' },
  { id: 'windmill',        name: 'Windmill',        emoji: '🏗', row: 1, col: 1, description: 'energy, cycles, labor' },
  { id: 'locksmith',       name: 'Locksmith',       emoji: '🔐', row: 1, col: 2, description: 'puzzles, secrets, access' },
  // Row 2
  { id: 'mystery-tower',   name: 'Mystery Tower',   emoji: '🗼', row: 2, col: 0, description: 'height, observation, unsolved meaning' },
  { id: 'theater',         name: 'Theater',         emoji: '🎭', row: 2, col: 1, description: 'performance, masks, rehearsal' },
  { id: 'square',          name: 'Square',          emoji: '⬜', row: 2, col: 2, description: 'meeting, civic rhythm, ordinary life' },
] as const;

export type BuildingId = typeof BUILDINGS[number]['id'];

/** Map from building ID to building object */
export const BUILDING_MAP = new Map<string, Building>(
  BUILDINGS.map((b) => [b.id, b])
);

/** Default starting locations per character */
export const DEFAULT_LOCATIONS: Record<string, BuildingId> = {
  'newtown': 'square',
  'neo': 'station',
  'plato': 'mystery-tower',
  'joe': 'square',
};

/** Type guard for valid building IDs */
export function isValidBuilding(id: string): id is BuildingId {
  return BUILDING_MAP.has(id);
}
