/**
 * System-wide event bus for live activity streaming.
 * Emits typed events when memories or messages are saved,
 * enabling real-time dashboards and monitoring.
 */

import { EventEmitter } from 'node:events';
import { getLogger } from '../utils/logger.js';

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
    object: 'object',
    experiment: 'experiment',
    'town-event': 'town-event',
    state: 'state',
    weather: 'weather',
  };
  return typeMap[prefix] ?? prefix;
}

/** Types that represent autonomous background activity (not user chat) */
const BACKGROUND_TYPES = new Set([
  'commune', 'diary', 'dream', 'curiosity', 'self-concept', 'narrative',
  'letter', 'peer', 'doctor', 'movement', 'move', 'note', 'document', 'gift',
  'townlife', 'object', 'experiment', 'town-event', 'state', 'weather',
]);

/** Returns true if the event type is autonomous background activity */
export function isBackgroundEvent(event: SystemEvent): boolean {
  return BACKGROUND_TYPES.has(event.type);
}

/**
 * Sentinel character id used when `emitActivity` is called before
 * `setCharacterId`. Prefer this over a real character id (like the old
 * default `'lain'`) so events from a mis-initialised process cannot be
 * silently merged into another character's activity feed.
 */
export const UNSET_CHARACTER = '__unset__';

class ActivityBus extends EventEmitter {
  // findings.md P2:295 — default used to be `'lain'`, so any character
  // server that booted without calling `setCharacterId` silently tagged
  // its events as Lain's. That's the exact "silent character-integrity"
  // failure class flagged in feedback_character_integrity.md.
  private _characterId: string | null = null;
  private _warnedUnsetEmit = false;

  constructor() {
    super();
    this.setMaxListeners(50); // Allow many background loops without warning
  }

  setCharacterId(id: string): void {
    this._characterId = id;
  }

  get characterId(): string | null {
    return this._characterId;
  }

  emitActivity(event: Omit<SystemEvent, 'character'>): void {
    let character = this._characterId;
    if (character == null) {
      if (!this._warnedUnsetEmit) {
        this._warnedUnsetEmit = true;
        getLogger().warn(
          { eventType: event.type, sessionKey: event.sessionKey },
          'ActivityBus.emitActivity called before setCharacterId — events will be tagged with sentinel and cannot be attributed. Call eventBus.setCharacterId(<id>) during process init.',
        );
      }
      character = UNSET_CHARACTER;
    }
    const full: SystemEvent = { ...event, character };
    this.emit('activity', full);
  }

  /** Test-only hook: rearm the warn-once guard and clear the character id. */
  _resetForTests(): void {
    this._characterId = null;
    this._warnedUnsetEmit = false;
  }
}

export const eventBus = new ActivityBus();
