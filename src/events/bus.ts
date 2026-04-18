/**
 * System-wide event bus for live activity streaming.
 * Emits typed events when memories or messages are saved,
 * enabling real-time dashboards and monitoring.
 */

import { EventEmitter } from 'node:events';

export interface SystemEvent {
  character: string;
  type: string;
  sessionKey: string;
  content: string;
  timestamp: number;
}

/**
 * Parse event type from a session key prefix.
 * e.g. "commune:pkd:1234" → "commune", "diary:2024" → "diary"
 */
export function parseEventType(sessionKey: string | null): string {
  if (!sessionKey) return 'unknown';
  const prefix = sessionKey.split(':')[0];
  if (!prefix) return 'unknown';
  // Map known prefixes
  const typeMap: Record<string, string> = {
    commune: 'commune',
    diary: 'diary',
    dream: 'dream',
    curiosity: 'curiosity',
    'self-concept': 'self-concept',
    selfconcept: 'self-concept',
    narrative: 'narrative',
    letter: 'letter',
    wired: 'letter',
    web: 'chat',
    peer: 'peer',
    telegram: 'chat',
    alien: 'dream',
    bibliomancy: 'curiosity',
    dr: 'doctor',
    doctor: 'doctor',
    proactive: 'chat',
    movement: 'movement',
    move: 'move',
    note: 'note',
    document: 'document',
    gift: 'gift',
    townlife: 'townlife',
  };
  return typeMap[prefix] ?? prefix;
}

/** Types that represent autonomous background activity (not user chat) */
const BACKGROUND_TYPES = new Set([
  'commune', 'diary', 'dream', 'curiosity', 'self-concept', 'narrative',
  'letter', 'peer', 'doctor', 'movement', 'move', 'note', 'document', 'gift',
  'townlife',
]);

/** Returns true if the event type is autonomous background activity */
export function isBackgroundEvent(event: SystemEvent): boolean {
  return BACKGROUND_TYPES.has(event.type);
}

class ActivityBus extends EventEmitter {
  private _characterId = 'lain';

  constructor() {
    super();
    this.setMaxListeners(50); // Allow many background loops without warning
  }

  setCharacterId(id: string): void {
    this._characterId = id;
  }

  get characterId(): string {
    return this._characterId;
  }

  emitActivity(event: Omit<SystemEvent, 'character'>): void {
    const full: SystemEvent = { ...event, character: this._characterId };
    this.emit('activity', full);
  }
}

export const eventBus = new ActivityBus();
