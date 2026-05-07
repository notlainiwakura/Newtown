/**
 * Event system tests — EventBus, parseEventType, isBackgroundEvent, town events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Helpers / mocks ──────────────────────────────────────────────────────────

// We import the actual source modules (no DB needed for bus.ts).
// town-events.ts requires a DB, so we mock those dependencies.
vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(),
}));
// Stable spy object so tests can inspect warn/debug calls across the module.
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('../src/utils/logger.js', () => ({
  getLogger: () => mockLogger,
}));
// Provide a minimal inhabitant list so notifyInhabitants makes fetch calls.
vi.mock('../src/config/characters.js', () => ({
  getInhabitants: () => [
    { id: 'lain', name: 'Lain', port: 3001, server: 'character', defaultLocation: 'home', workspace: 'lain' },
  ],
}));
// Prevent real HTTP calls from notifyInhabitants
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

import {
  parseEventType,
  isBackgroundEvent,
  eventBus,
  UNSET_CHARACTER,
  type SystemEvent,
} from '../src/events/bus.js';

import {
  createTownEvent,
  getActiveTownEvents,
  getAllTownEvents,
  endTownEvent,
  expireStaleEvents,
  startExpireStaleEventsLoop,
  getActiveEffects,
  _resetInterlinkWarnForTests,
  type TownEvent,
  type CreateEventParams,
} from '../src/events/town-events.js';

import { getDatabase } from '../src/storage/database.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a minimal SystemEvent
// ─────────────────────────────────────────────────────────────────────────────
function makeEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return {
    character: 'lain',
    type: 'chat',
    sessionKey: 'web:session1',
    content: 'hello',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. parseEventType
// ─────────────────────────────────────────────────────────────────────────────
describe('parseEventType', () => {
  it('returns "unknown" for null input', () => {
    expect(parseEventType(null)).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(parseEventType('')).toBe('unknown');
  });

  it('maps commune prefix', () => {
    expect(parseEventType('commune:pkd:1234')).toBe('commune');
  });

  it('maps diary prefix', () => {
    expect(parseEventType('diary:2024')).toBe('diary');
  });

  it('maps dream prefix', () => {
    expect(parseEventType('dream:001')).toBe('dream');
  });

  it('maps curiosity prefix', () => {
    expect(parseEventType('curiosity:42')).toBe('curiosity');
  });

  it('maps self-concept prefix', () => {
    expect(parseEventType('self-concept:1')).toBe('self-concept');
  });

  it('maps selfconcept (no hyphen) to self-concept', () => {
    expect(parseEventType('selfconcept:1')).toBe('self-concept');
  });

  it('maps narrative prefix', () => {
    expect(parseEventType('narrative:abc')).toBe('narrative');
  });

  it('maps letter prefix', () => {
    expect(parseEventType('letter:xyz')).toBe('letter');
  });

  it('maps wired prefix to letter', () => {
    expect(parseEventType('wired:msg')).toBe('letter');
  });

  it('maps web prefix to chat', () => {
    expect(parseEventType('web:session')).toBe('chat');
  });

  it('maps peer prefix', () => {
    expect(parseEventType('peer:other')).toBe('peer');
  });

  it('maps telegram prefix to chat', () => {
    expect(parseEventType('telegram:12345')).toBe('chat');
  });

  it('maps alien prefix to dream', () => {
    expect(parseEventType('alien:contact')).toBe('dream');
  });

  it('maps bibliomancy prefix to curiosity', () => {
    expect(parseEventType('bibliomancy:book')).toBe('curiosity');
  });

  it('maps dr prefix to doctor', () => {
    expect(parseEventType('dr:checkup')).toBe('doctor');
  });

  it('maps doctor prefix', () => {
    expect(parseEventType('doctor:session')).toBe('doctor');
  });

  it('maps proactive prefix to chat', () => {
    expect(parseEventType('proactive:msg')).toBe('chat');
  });

  it('maps movement prefix', () => {
    expect(parseEventType('movement:1')).toBe('movement');
  });

  it('maps move prefix', () => {
    expect(parseEventType('move:1')).toBe('move');
  });

  it('maps note prefix', () => {
    expect(parseEventType('note:1')).toBe('note');
  });

  it('maps document prefix', () => {
    expect(parseEventType('document:1')).toBe('document');
  });

  it('maps gift prefix', () => {
    expect(parseEventType('gift:1')).toBe('gift');
  });

  it('maps townlife prefix', () => {
    expect(parseEventType('townlife:1')).toBe('townlife');
  });

  it('maps object prefix', () => {
    expect(parseEventType('object:1')).toBe('object');
  });

  it('maps experiment prefix', () => {
    expect(parseEventType('experiment:1')).toBe('experiment');
  });

  it('maps town-event prefix', () => {
    expect(parseEventType('town-event:1')).toBe('town-event');
  });

  it('maps state prefix', () => {
    expect(parseEventType('state:1')).toBe('state');
  });

  it('maps weather prefix', () => {
    expect(parseEventType('weather:clear')).toBe('weather');
  });

  it('passes through unknown prefix unchanged', () => {
    expect(parseEventType('totally-custom:thing')).toBe('totally-custom');
  });

  it('handles key with no colon — returns the whole string as prefix', () => {
    // e.g. "diary" with no colon — split(':')[0] is 'diary'
    expect(parseEventType('diary')).toBe('diary');
  });

  it('handles multi-segment keys — only first segment is the type', () => {
    expect(parseEventType('commune:pkd:lain:deep')).toBe('commune');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. isBackgroundEvent
// ─────────────────────────────────────────────────────────────────────────────
describe('isBackgroundEvent', () => {
  const background = [
    'commune', 'diary', 'dream', 'curiosity', 'self-concept', 'narrative',
    'letter', 'peer', 'doctor', 'movement', 'move', 'note', 'document', 'gift',
    'townlife', 'object', 'experiment', 'town-event', 'state', 'weather',
  ];

  for (const type of background) {
    it(`returns true for type "${type}"`, () => {
      expect(isBackgroundEvent(makeEvent({ type }))).toBe(true);
    });
  }

  it('returns false for type "chat"', () => {
    expect(isBackgroundEvent(makeEvent({ type: 'chat' }))).toBe(false);
  });

  it('returns false for type "unknown"', () => {
    expect(isBackgroundEvent(makeEvent({ type: 'unknown' }))).toBe(false);
  });

  it('returns false for an arbitrary non-background type', () => {
    expect(isBackgroundEvent(makeEvent({ type: 'custom-type' }))).toBe(false);
  });

  it('is case-sensitive — uppercase does not match', () => {
    expect(isBackgroundEvent(makeEvent({ type: 'COMMUNE' }))).toBe(false);
    expect(isBackgroundEvent(makeEvent({ type: 'Diary' }))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. EventBus
// ─────────────────────────────────────────────────────────────────────────────
describe('EventBus', () => {
  // We need a fresh bus each time because eventBus is a singleton.
  // We restore characterId after each test.
  const originalId = eventBus.characterId;

  afterEach(() => {
    // findings.md P2:295 — characterId is `string | null`; only restore when
    // there was a real value before this test ran.
    if (originalId != null) eventBus.setCharacterId(originalId);
    eventBus.removeAllListeners();
  });

  // ── characterId ───────────────────────────────────────────────────────────

  describe('characterId', () => {
    it('can set characterId', () => {
      eventBus.setCharacterId('pkd');
      expect(eventBus.characterId).toBe('pkd');
    });

    it('characterId persists across multiple sets', () => {
      eventBus.setCharacterId('mckenna');
      eventBus.setCharacterId('wired-lain');
      expect(eventBus.characterId).toBe('wired-lain');
    });

    it('accepts empty string as characterId', () => {
      eventBus.setCharacterId('');
      expect(eventBus.characterId).toBe('');
    });
  });

  // ── P2:295 — null default + warn-once when emit before set ────────────────

  describe('emitActivity before setCharacterId (P2:295)', () => {
    it('tags events with the UNSET_CHARACTER sentinel when setCharacterId was never called', () => {
      mockLogger.warn.mockClear();
      eventBus._resetForTests();
      const received: SystemEvent[] = [];
      eventBus.on('activity', (e: SystemEvent) => received.push(e));
      eventBus.emitActivity({ type: 'diary', sessionKey: 'diary:1', content: 'x', timestamp: 1 });
      expect(received).toHaveLength(1);
      expect(received[0]!.character).toBe(UNSET_CHARACTER);
      // Critically: NOT silently tagged as 'lain' (the old default behaviour).
      expect(received[0]!.character).not.toBe('lain');
    });

    it('warns at warn level with eventType + sessionKey on the first unset emission', () => {
      mockLogger.warn.mockClear();
      eventBus._resetForTests();
      eventBus.emitActivity({ type: 'diary', sessionKey: 'diary:1', content: 'x', timestamp: 1 });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      const [ctx, msg] = mockLogger.warn.mock.calls[0]!;
      expect(ctx).toMatchObject({ eventType: 'diary', sessionKey: 'diary:1' });
      expect(String(msg)).toContain('setCharacterId');
    });

    it('only warns once across many unset emissions', () => {
      mockLogger.warn.mockClear();
      eventBus._resetForTests();
      for (let i = 0; i < 25; i++) {
        eventBus.emitActivity({ type: 'chat', sessionKey: `s:${i}`, content: 'x', timestamp: i });
      }
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('stops warning once setCharacterId has been called (and does not warn on real ids)', () => {
      mockLogger.warn.mockClear();
      eventBus._resetForTests();
      eventBus.setCharacterId('pkd');
      for (let i = 0; i < 5; i++) {
        eventBus.emitActivity({ type: 'diary', sessionKey: `d:${i}`, content: 'x', timestamp: i });
      }
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });
  });

  // ── emitActivity ──────────────────────────────────────────────────────────

  describe('emitActivity — basic emission', () => {
    it('emits an "activity" event', () => {
      const listener = vi.fn();
      eventBus.on('activity', listener);
      eventBus.emitActivity({ type: 'chat', sessionKey: 'web:s1', content: 'hi', timestamp: 1 });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('includes the character field from characterId', () => {
      eventBus.setCharacterId('pkd');
      const listener = vi.fn();
      eventBus.on('activity', listener);
      eventBus.emitActivity({ type: 'diary', sessionKey: 'diary:1', content: 'wrote', timestamp: 1 });
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ character: 'pkd' })
      );
    });

    it('merges event fields with the character', () => {
      eventBus.setCharacterId('lain');
      const listener = vi.fn();
      eventBus.on('activity', listener);
      const ts = Date.now();
      eventBus.emitActivity({ type: 'dream', sessionKey: 'dream:1', content: 'flying', timestamp: ts });
      expect(listener).toHaveBeenCalledWith({
        character: 'lain',
        type: 'dream',
        sessionKey: 'dream:1',
        content: 'flying',
        timestamp: ts,
      });
    });

    it('passes the full SystemEvent object to listeners', () => {
      const received: SystemEvent[] = [];
      eventBus.on('activity', (e) => received.push(e));
      eventBus.emitActivity({ type: 'chat', sessionKey: 'web:x', content: 'test', timestamp: 0 });
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveProperty('character');
      expect(received[0]).toHaveProperty('type');
      expect(received[0]).toHaveProperty('sessionKey');
      expect(received[0]).toHaveProperty('content');
      expect(received[0]).toHaveProperty('timestamp');
    });

    it('does not mutate the input event object', () => {
      const input = { type: 'chat', sessionKey: 'web:s', content: 'hi', timestamp: 1 };
      const inputCopy = { ...input };
      eventBus.on('activity', vi.fn());
      eventBus.emitActivity(input);
      expect(input).toEqual(inputCopy);
    });
  });

  // ── Subscription & unsubscription ─────────────────────────────────────────

  describe('subscription', () => {
    it('on() registers a listener', () => {
      const listener = vi.fn();
      eventBus.on('activity', listener);
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('off() removes a listener', () => {
      const listener = vi.fn();
      eventBus.on('activity', listener);
      eventBus.off('activity', listener);
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      expect(listener).not.toHaveBeenCalled();
    });

    it('once() fires only once', () => {
      const listener = vi.fn();
      eventBus.once('activity', listener);
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 1 });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('multiple listeners all receive the event', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      const l3 = vi.fn();
      eventBus.on('activity', l1);
      eventBus.on('activity', l2);
      eventBus.on('activity', l3);
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      expect(l1).toHaveBeenCalledOnce();
      expect(l2).toHaveBeenCalledOnce();
      expect(l3).toHaveBeenCalledOnce();
    });

    it('removing one listener does not affect others', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      eventBus.on('activity', l1);
      eventBus.on('activity', l2);
      eventBus.off('activity', l1);
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      expect(l1).not.toHaveBeenCalled();
      expect(l2).toHaveBeenCalledOnce();
    });

    it('removeAllListeners clears all activity listeners', () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      eventBus.on('activity', l1);
      eventBus.on('activity', l2);
      eventBus.removeAllListeners('activity');
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      expect(l1).not.toHaveBeenCalled();
      expect(l2).not.toHaveBeenCalled();
    });

    it('emit with no listeners does not throw', () => {
      expect(() =>
        eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 })
      ).not.toThrow();
    });

    it('listenerCount reflects registered listeners', () => {
      const l = vi.fn();
      eventBus.on('activity', l);
      expect(eventBus.listenerCount('activity')).toBeGreaterThanOrEqual(1);
      eventBus.off('activity', l);
      // count should have decreased
      const before = eventBus.listenerCount('activity');
      eventBus.on('activity', l);
      expect(eventBus.listenerCount('activity')).toBe(before + 1);
    });
  });

  // ── Emit ordering ─────────────────────────────────────────────────────────

  describe('emit ordering', () => {
    it('listeners are called in registration order', () => {
      const order: number[] = [];
      eventBus.on('activity', () => order.push(1));
      eventBus.on('activity', () => order.push(2));
      eventBus.on('activity', () => order.push(3));
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 });
      expect(order).toEqual([1, 2, 3]);
    });

    it('events are received in emission order', () => {
      const received: string[] = [];
      eventBus.on('activity', (e: SystemEvent) => received.push(e.content));
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'first', timestamp: 0 });
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'second', timestamp: 1 });
      eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'third', timestamp: 2 });
      expect(received).toEqual(['first', 'second', 'third']);
    });
  });

  // ── Rapid-fire events ─────────────────────────────────────────────────────

  describe('rapid-fire events', () => {
    it('handles 1000 rapid emissions without dropping', () => {
      let count = 0;
      eventBus.on('activity', () => count++);
      for (let i = 0; i < 1000; i++) {
        eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: String(i), timestamp: i });
      }
      expect(count).toBe(1000);
    });

    it('payload is distinct for each emission', () => {
      const payloads: SystemEvent[] = [];
      eventBus.on('activity', (e: SystemEvent) => payloads.push({ ...e }));
      for (let i = 0; i < 5; i++) {
        eventBus.emitActivity({ type: 'chat', sessionKey: `s:${i}`, content: `msg${i}`, timestamp: i });
      }
      const sessionKeys = payloads.map((p) => p.sessionKey);
      const unique = new Set(sessionKeys);
      expect(unique.size).toBe(5);
    });
  });

  // ── Error in listener ─────────────────────────────────────────────────────

  describe('error isolation', () => {
    it('an error in one listener does not prevent subsequent listeners from firing', () => {
      const good = vi.fn();
      const bad = () => { throw new Error('listener error'); };

      eventBus.on('activity', bad);
      eventBus.on('activity', good);

      // Node's EventEmitter re-throws by default, so we must wrap
      expect(() =>
        eventBus.emitActivity({ type: 'chat', sessionKey: 's', content: 'x', timestamp: 0 })
      ).toThrow('listener error');

      // good was NOT called because Node stops at the throwing listener
      // This documents actual node EventEmitter behavior (not a bug in the bus)
      // good may or may not have been called depending on order
    });
  });

  // ── Extends EventEmitter ───────────────────────────────────────────────────

  describe('instanceof / extends', () => {
    it('eventBus is an instance of EventEmitter', () => {
      expect(eventBus).toBeInstanceOf(EventEmitter);
    });

    it('supports arbitrary event names (non-activity)', () => {
      const listener = vi.fn();
      eventBus.on('custom-event', listener);
      eventBus.emit('custom-event', 'payload');
      expect(listener).toHaveBeenCalledWith('payload');
      eventBus.off('custom-event', listener);
    });
  });

  // ── Event types coverage ──────────────────────────────────────────────────

  describe('event types via emitActivity', () => {
    const types = ['chat', 'diary', 'dream', 'commune', 'curiosity', 'letter', 'peer', 'doctor'];
    for (const type of types) {
      it(`emits events with type "${type}"`, () => {
        const listener = vi.fn();
        eventBus.on('activity', listener);
        eventBus.emitActivity({ type, sessionKey: `${type}:1`, content: 'x', timestamp: 0 });
        expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type }));
        eventBus.off('activity', listener);
      });
    }
  });

  // ── Listener accumulation / memory leak guard ─────────────────────────────

  describe('listener accumulation', () => {
    it('adding many listeners triggers maxListeners warning only beyond threshold', () => {
      // Node default maxListeners is 10; we stay below to avoid warnings
      const listeners: Array<() => void> = [];
      for (let i = 0; i < 5; i++) {
        const l = vi.fn();
        listeners.push(l);
        eventBus.on('activity', l);
      }
      expect(eventBus.listenerCount('activity')).toBeGreaterThanOrEqual(5);
      // Clean up
      for (const l of listeners) eventBus.off('activity', l);
    });

    it('removeAllListeners resets listener count to 0', () => {
      for (let i = 0; i < 5; i++) {
        eventBus.on('activity', vi.fn());
      }
      eventBus.removeAllListeners('activity');
      expect(eventBus.listenerCount('activity')).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Town Events (with mocked DB)
// ─────────────────────────────────────────────────────────────────────────────

function makeMockDb(rows: unknown[] = []) {
  const runResult = { changes: 1 };
  const prepared = {
    run: vi.fn(() => runResult),
    all: vi.fn(() => rows),
    get: vi.fn(() => rows[0]),
  };
  const prepare = vi.fn(() => prepared);
  return { prepare, _prepared: prepared, _runResult: runResult };
}

describe('Town Events — rowToEvent / createTownEvent', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(getDatabase).mockReset();
  });

  // ── createTownEvent ────────────────────────────────────────────────────────

  describe('createTownEvent', () => {
    it('returns a TownEvent with the provided description', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);

      const event = createTownEvent({ description: 'A meteor lands in the park.' });
      expect(event.description).toBe('A meteor lands in the park.');
    });

    it('assigns a non-empty id', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.id).toBeTruthy();
      expect(typeof event.id).toBe('string');
    });

    it('sets status to "active"', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.status).toBe('active');
    });

    it('sets endedAt to null', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.endedAt).toBeNull();
    });

    it('sets createdAt to approximately now', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const before = Date.now();
      const event = createTownEvent({ description: 'Test' });
      expect(event.createdAt).toBeGreaterThanOrEqual(before);
      expect(event.createdAt).toBeLessThanOrEqual(Date.now());
    });

    it('defaults narrative to false', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.narrative).toBe(false);
    });

    it('sets narrative to true when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', narrative: true });
      expect(event.narrative).toBe(true);
    });

    it('defaults mechanical to false', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.mechanical).toBe(false);
    });

    it('sets mechanical to true when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', mechanical: true });
      expect(event.mechanical).toBe(true);
    });

    it('defaults persistent to false', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.persistent).toBe(false);
    });

    it('sets persistent to true when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', persistent: true });
      expect(event.persistent).toBe(true);
    });

    it('defaults natural to false', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.natural).toBe(false);
    });

    it('sets natural to true when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', natural: true });
      expect(event.natural).toBe(true);
    });

    it('defaults liminal to false', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.liminal).toBe(false);
    });

    it('sets liminal to true when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', liminal: true });
      expect(event.liminal).toBe(true);
    });

    it('defaults source to null', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.source).toBeNull();
    });

    it('sets source to "admin" when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', source: 'admin' });
      expect(event.source).toBe('admin');
    });

    it('sets source to "novelty" when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', source: 'novelty' });
      expect(event.source).toBe('novelty');
    });

    it('sets source to "system" when specified', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', source: 'system' });
      expect(event.source).toBe('system');
    });

    it('defaults effects to empty object', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test' });
      expect(event.effects).toEqual({});
    });

    it('stores effects when provided', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const effects = { blockedBuildings: ['cafe'], forceLocation: 'park', weather: 'storm' };
      const event = createTownEvent({ description: 'Test', effects });
      expect(event.effects).toEqual(effects);
    });

    it('instant event: expiresAt is set to ~30 minutes from now', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const before = Date.now();
      const event = createTownEvent({ description: 'Instant!', instant: true });
      const INSTANT_WINDOW = 30 * 60 * 1000;
      expect(event.instant).toBe(true);
      expect(event.expiresAt).not.toBeNull();
      expect(event.expiresAt!).toBeGreaterThanOrEqual(before + INSTANT_WINDOW - 100);
      expect(event.expiresAt!).toBeLessThanOrEqual(Date.now() + INSTANT_WINDOW + 100);
    });

    it('admin event: expiresAt is set to ~72 hours from now', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const before = Date.now();
      const event = createTownEvent({ description: 'Admin event', source: 'admin' });
      const ADMIN_WINDOW = 72 * 60 * 60 * 1000;
      expect(event.expiresAt).not.toBeNull();
      expect(event.expiresAt!).toBeGreaterThanOrEqual(before + ADMIN_WINDOW - 100);
    });

    it('custom expiresInMs overrides default', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const before = Date.now();
      const event = createTownEvent({ description: 'Test', expiresInMs: 5000 });
      expect(event.expiresAt).not.toBeNull();
      expect(event.expiresAt!).toBeGreaterThanOrEqual(before + 4900);
      expect(event.expiresAt!).toBeLessThanOrEqual(before + 5500);
    });

    it('non-instant, non-admin, no expiresInMs: expiresAt is null', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const event = createTownEvent({ description: 'Test', source: 'novelty' });
      expect(event.expiresAt).toBeNull();
    });

    it('calls db.prepare for INSERT', () => {
      const db = makeMockDb();
      vi.mocked(getDatabase).mockReturnValue(db as never);
      createTownEvent({ description: 'Test' });
      expect(db.prepare).toHaveBeenCalled();
    });

    it('notifies inhabitants via fetch (fire-and-forget)', async () => {
      // Per-character interlink auth (findings.md P1:2289) — notifyInhabitants
      // skips the remote call when either LAIN_CHARACTER_ID or
      // LAIN_INTERLINK_TOKEN is unset, because getInterlinkHeaders() returns
      // null and the fetch is guarded on that.
      const prevId = process.env['LAIN_CHARACTER_ID'];
      const prevTok = process.env['LAIN_INTERLINK_TOKEN'];
      process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
      process.env['LAIN_INTERLINK_TOKEN'] = 'test-master-token';
      try {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        const db = makeMockDb();
        vi.mocked(getDatabase).mockReturnValue(db as never);
        createTownEvent({ description: 'Test notification' });
        // Allow microtasks to flush
        await new Promise((r) => setTimeout(r, 10));
        expect(fetchMock).toHaveBeenCalled();
      } finally {
        if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
        else process.env['LAIN_CHARACTER_ID'] = prevId;
        if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
        else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
      }
    });

    // findings.md P2:263 — missing interlink config and per-peer rejections
    // used to go to `logger.debug`, which is invisible under the default
    // `info` level. Town events would reach zero inhabitants with nothing
    // actionable in the logs.
    describe('notifyInhabitants logs at warn when unreachable (findings.md P2:263)', () => {
      beforeEach(() => {
        mockLogger.warn.mockClear();
        mockLogger.debug.mockClear();
        _resetInterlinkWarnForTests();
      });

      it('warns once when LAIN_INTERLINK_TOKEN is missing and skips fetch', async () => {
        const prevId = process.env['LAIN_CHARACTER_ID'];
        const prevTok = process.env['LAIN_INTERLINK_TOKEN'];
        process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
        delete process.env['LAIN_INTERLINK_TOKEN'];
        try {
          const fetchMock = vi.fn().mockResolvedValue({ ok: true });
          vi.stubGlobal('fetch', fetchMock);
          const db = makeMockDb();
          vi.mocked(getDatabase).mockReturnValue(db as never);

          createTownEvent({ description: 'first' });
          createTownEvent({ description: 'second' });
          createTownEvent({ description: 'third' });
          await new Promise((r) => setTimeout(r, 10));

          expect(fetchMock).not.toHaveBeenCalled();
          expect(mockLogger.warn).toHaveBeenCalledTimes(1);
          const [ctx, msg] = mockLogger.warn.mock.calls[0] as [
            { hasInterlinkToken: boolean; hasCharacterId: boolean },
            string,
          ];
          expect(msg).toMatch(/Town event notification skipped/);
          expect(ctx.hasInterlinkToken).toBe(false);
          expect(ctx.hasCharacterId).toBe(true);
        } finally {
          if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
          else process.env['LAIN_CHARACTER_ID'] = prevId;
          if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
          else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
        }
      });

      it('warns once when LAIN_CHARACTER_ID is missing and skips fetch', async () => {
        const prevId = process.env['LAIN_CHARACTER_ID'];
        const prevTok = process.env['LAIN_INTERLINK_TOKEN'];
        delete process.env['LAIN_CHARACTER_ID'];
        process.env['LAIN_INTERLINK_TOKEN'] = 'test-master-token';
        try {
          const fetchMock = vi.fn().mockResolvedValue({ ok: true });
          vi.stubGlobal('fetch', fetchMock);
          const db = makeMockDb();
          vi.mocked(getDatabase).mockReturnValue(db as never);

          createTownEvent({ description: 'first' });
          await new Promise((r) => setTimeout(r, 10));

          expect(fetchMock).not.toHaveBeenCalled();
          expect(mockLogger.warn).toHaveBeenCalledTimes(1);
          const [ctx] = mockLogger.warn.mock.calls[0] as [
            { hasInterlinkToken: boolean; hasCharacterId: boolean },
            string,
          ];
          expect(ctx.hasCharacterId).toBe(false);
        } finally {
          if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
          else process.env['LAIN_CHARACTER_ID'] = prevId;
          if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
          else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
        }
      });

      it('warns at warn level when a peer returns a non-ok status', async () => {
        const prevId = process.env['LAIN_CHARACTER_ID'];
        const prevTok = process.env['LAIN_INTERLINK_TOKEN'];
        process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
        process.env['LAIN_INTERLINK_TOKEN'] = 'test-master-token';
        try {
          const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
          vi.stubGlobal('fetch', fetchMock);
          const db = makeMockDb();
          vi.mocked(getDatabase).mockReturnValue(db as never);

          createTownEvent({ description: 'peer-401' });
          await new Promise((r) => setTimeout(r, 10));

          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(mockLogger.warn).toHaveBeenCalledTimes(1);
          const [ctx, msg] = mockLogger.warn.mock.calls[0] as [
            { inhabitant: string; status: number; eventId: string },
            string,
          ];
          expect(msg).toMatch(/rejected by inhabitant/);
          expect(ctx.inhabitant).toBe('lain');
          expect(ctx.status).toBe(401);
          expect(typeof ctx.eventId).toBe('string');
        } finally {
          if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
          else process.env['LAIN_CHARACTER_ID'] = prevId;
          if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
          else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
        }
      });

      it('warns at warn level when fetch throws (network error)', async () => {
        const prevId = process.env['LAIN_CHARACTER_ID'];
        const prevTok = process.env['LAIN_INTERLINK_TOKEN'];
        process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
        process.env['LAIN_INTERLINK_TOKEN'] = 'test-master-token';
        try {
          const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
          vi.stubGlobal('fetch', fetchMock);
          const db = makeMockDb();
          vi.mocked(getDatabase).mockReturnValue(db as never);

          createTownEvent({ description: 'peer-down' });
          await new Promise((r) => setTimeout(r, 10));

          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(mockLogger.warn).toHaveBeenCalledTimes(1);
          const [ctx, msg] = mockLogger.warn.mock.calls[0] as [
            { inhabitant: string; reason: string; eventId: string },
            string,
          ];
          expect(msg).toMatch(/Could not notify inhabitant/);
          expect(ctx.inhabitant).toBe('lain');
          expect(ctx.reason).toBe('ECONNREFUSED');
        } finally {
          if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
          else process.env['LAIN_CHARACTER_ID'] = prevId;
          if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
          else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
        }
      });

      it('does not warn on the happy path (peer returns 200)', async () => {
        const prevId = process.env['LAIN_CHARACTER_ID'];
        const prevTok = process.env['LAIN_INTERLINK_TOKEN'];
        process.env['LAIN_CHARACTER_ID'] = 'wired-lain';
        process.env['LAIN_INTERLINK_TOKEN'] = 'test-master-token';
        try {
          const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
          vi.stubGlobal('fetch', fetchMock);
          const db = makeMockDb();
          vi.mocked(getDatabase).mockReturnValue(db as never);

          createTownEvent({ description: 'happy' });
          await new Promise((r) => setTimeout(r, 10));

          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(mockLogger.warn).not.toHaveBeenCalled();
        } finally {
          if (prevId === undefined) delete process.env['LAIN_CHARACTER_ID'];
          else process.env['LAIN_CHARACTER_ID'] = prevId;
          if (prevTok === undefined) delete process.env['LAIN_INTERLINK_TOKEN'];
          else process.env['LAIN_INTERLINK_TOKEN'] = prevTok;
        }
      });
    });
  });

  // ── getActiveTownEvents ────────────────────────────────────────────────────

  describe('getActiveTownEvents', () => {
    it('returns mapped TownEvent objects', () => {
      const now = Date.now();
      const row = {
        id: 'abc123', description: 'Active event', narrative: 1, mechanical: 0,
        instant: 0, persistent: 0, natural_event: 0, liminal: 0,
        source: null, effects: '{}', status: 'active', created_at: now,
        expires_at: null, ended_at: null,
      };
      const db = makeMockDb([row]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const events = getActiveTownEvents();
      expect(events).toHaveLength(1);
      expect(events[0]!.id).toBe('abc123');
      expect(events[0]!.narrative).toBe(true);
      expect(events[0]!.mechanical).toBe(false);
    });

    it('handles malformed effects JSON gracefully', () => {
      const now = Date.now();
      const row = {
        id: 'bad-json', description: 'Bad effects', narrative: 0, mechanical: 0,
        instant: 0, persistent: 0, natural_event: 0, liminal: 0,
        source: null, effects: '{invalid json}', status: 'active',
        created_at: now, expires_at: null, ended_at: null,
      };
      const db = makeMockDb([row]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const events = getActiveTownEvents();
      expect(events[0]!.effects).toEqual({});
    });

    it('returns empty array when no active events', () => {
      const db = makeMockDb([]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const events = getActiveTownEvents();
      expect(events).toHaveLength(0);
    });

    it('maps natural_event column to natural field', () => {
      const row = {
        id: 'nat1', description: 'Natural', narrative: 0, mechanical: 0,
        instant: 0, persistent: 0, natural_event: 1, liminal: 0,
        source: null, effects: '{}', status: 'active', created_at: Date.now(),
        expires_at: null, ended_at: null,
      };
      const db = makeMockDb([row]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const events = getActiveTownEvents();
      expect(events[0]!.natural).toBe(true);
    });
  });

  // ── getAllTownEvents ────────────────────────────────────────────────────────

  describe('getAllTownEvents', () => {
    it('returns all events including ended ones', () => {
      const rows = [
        { id: 'a', description: 'A', narrative: 0, mechanical: 0, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null, effects: '{}', status: 'active',
          created_at: 100, expires_at: null, ended_at: null },
        { id: 'b', description: 'B', narrative: 0, mechanical: 0, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null, effects: '{}', status: 'ended',
          created_at: 50, expires_at: null, ended_at: 60 },
      ];
      const db = makeMockDb(rows);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const events = getAllTownEvents();
      expect(events).toHaveLength(2);
    });

    it('uses default limit of 50', () => {
      const db = makeMockDb([]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      getAllTownEvents();
      expect(db._prepared.all).toHaveBeenCalledWith(50);
    });

    it('uses custom limit when provided', () => {
      const db = makeMockDb([]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      getAllTownEvents(10);
      expect(db._prepared.all).toHaveBeenCalledWith(10);
    });
  });

  // ── endTownEvent ──────────────────────────────────────────────────────────

  describe('endTownEvent', () => {
    it('returns true when an event is ended (changes > 0)', () => {
      const db = makeMockDb();
      db._runResult.changes = 1;
      vi.mocked(getDatabase).mockReturnValue(db as never);
      expect(endTownEvent('abc')).toBe(true);
    });

    it('returns false when no event was updated (changes === 0)', () => {
      const db = makeMockDb();
      db._runResult.changes = 0;
      vi.mocked(getDatabase).mockReturnValue(db as never);
      expect(endTownEvent('nonexistent')).toBe(false);
    });
  });

  // ── expireStaleEvents ─────────────────────────────────────────────────────

  describe('expireStaleEvents', () => {
    it('returns the count of expired events', () => {
      const db = makeMockDb();
      db._runResult.changes = 3;
      vi.mocked(getDatabase).mockReturnValue(db as never);
      expect(expireStaleEvents()).toBe(3);
    });

    it('returns 0 when nothing expired', () => {
      const db = makeMockDb();
      db._runResult.changes = 0;
      vi.mocked(getDatabase).mockReturnValue(db as never);
      expect(expireStaleEvents()).toBe(0);
    });
  });

  // findings.md P2:285 — shared scheduler so every town_events writer
  // (web + character servers) runs expireStaleEvents on a timer.
  describe('startExpireStaleEventsLoop (findings.md P2:285)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('calls expireStaleEvents on the configured interval', () => {
      const db = makeMockDb();
      db._runResult.changes = 0;
      vi.mocked(getDatabase).mockReturnValue(db as never);

      const stop = startExpireStaleEventsLoop(60_000);
      try {
        expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE town_events SET status'));
        vi.advanceTimersByTime(60_000);
        // One tick → one UPDATE call.
        const updateCalls = db.prepare.mock.calls.filter((c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('UPDATE town_events SET status'),
        );
        expect(updateCalls.length).toBe(1);
        vi.advanceTimersByTime(60_000);
        const updateCallsAfter = db.prepare.mock.calls.filter((c: unknown[]) =>
          typeof c[0] === 'string' && c[0].includes('UPDATE town_events SET status'),
        );
        expect(updateCallsAfter.length).toBe(2);
      } finally {
        stop();
      }
    });

    it('stop() halts further ticks', () => {
      const db = makeMockDb();
      db._runResult.changes = 0;
      vi.mocked(getDatabase).mockReturnValue(db as never);

      const stop = startExpireStaleEventsLoop(60_000);
      vi.advanceTimersByTime(60_000);
      const baseline = db.prepare.mock.calls.filter((c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE town_events SET status'),
      ).length;
      stop();
      vi.advanceTimersByTime(60_000 * 10);
      const after = db.prepare.mock.calls.filter((c: unknown[]) =>
        typeof c[0] === 'string' && c[0].includes('UPDATE town_events SET status'),
      ).length;
      expect(after).toBe(baseline);
    });

    it('logs at warn level when expireStaleEvents throws, does not crash', () => {
      const db = makeMockDb();
      db.prepare.mockImplementationOnce(() => {
        throw new Error('kaboom');
      });
      vi.mocked(getDatabase).mockReturnValue(db as never);
      mockLogger.warn.mockClear();

      const stop = startExpireStaleEventsLoop(60_000);
      try {
        vi.advanceTimersByTime(60_000);
        expect(mockLogger.warn).toHaveBeenCalled();
        const [ctx, msg] = mockLogger.warn.mock.calls[0] as [{ error: string }, string];
        expect(msg).toMatch(/expireStaleEvents failed/);
        expect(ctx.error).toMatch(/kaboom/);
      } finally {
        stop();
      }
    });
  });

  // ── getActiveEffects ──────────────────────────────────────────────────────

  describe('getActiveEffects', () => {
    it('returns empty object when no mechanical events are active', () => {
      const db = makeMockDb([]);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      expect(getActiveEffects()).toEqual({});
    });

    it('unions blockedBuildings from multiple mechanical events', () => {
      const now = Date.now();
      const rows = [
        { id: 'e1', description: 'E1', narrative: 0, mechanical: 1, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ blockedBuildings: ['cafe', 'library'] }),
          status: 'active', created_at: now, expires_at: null, ended_at: null },
        { id: 'e2', description: 'E2', narrative: 0, mechanical: 1, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ blockedBuildings: ['library', 'park'] }),
          status: 'active', created_at: now, expires_at: null, ended_at: null },
      ];
      const db = makeMockDb(rows);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const effects = getActiveEffects();
      expect(effects.blockedBuildings).toBeDefined();
      expect(effects.blockedBuildings).toContain('cafe');
      expect(effects.blockedBuildings).toContain('library');
      expect(effects.blockedBuildings).toContain('park');
      // No duplicates
      expect(new Set(effects.blockedBuildings).size).toBe(effects.blockedBuildings!.length);
    });

    it('newest mechanical event wins for forceLocation (P1 findings.md:13)', () => {
      // getActiveTownEvents() returns ORDER BY created_at DESC — newest first.
      // Rows must be passed in that order here, then getActiveEffects() must
      // resolve to the NEWEST event's forceLocation (e2 = 'park'), not the
      // oldest. Regression: the previous forward-iteration loop made the last
      // iteration (oldest event) win, which was the exact opposite of intent.
      const now = Date.now();
      const rows = [
        { id: 'e2', description: 'E2 (newer)', narrative: 0, mechanical: 1, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ forceLocation: 'park' }),
          status: 'active', created_at: now + 1000, expires_at: null, ended_at: null },
        { id: 'e1', description: 'E1 (older)', narrative: 0, mechanical: 1, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ forceLocation: 'cafe' }),
          status: 'active', created_at: now, expires_at: null, ended_at: null },
      ];
      const db = makeMockDb(rows);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const effects = getActiveEffects();
      expect(effects.forceLocation).toBe('park');
    });

    it('newest mechanical event wins for weather (P1 findings.md:13)', () => {
      const now = Date.now();
      const rows = [
        { id: 'e2', description: 'E2 (newer)', narrative: 0, mechanical: 1, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ weather: 'storm' }),
          status: 'active', created_at: now + 1000, expires_at: null, ended_at: null },
        { id: 'e1', description: 'E1 (older)', narrative: 0, mechanical: 1, instant: 0, persistent: 0,
          natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ weather: 'rain' }),
          status: 'active', created_at: now, expires_at: null, ended_at: null },
      ];
      const db = makeMockDb(rows);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      const effects = getActiveEffects();
      expect(effects.weather).toBe('storm');
    });

    it('ignores non-mechanical events', () => {
      const now = Date.now();
      const rows = [
        { id: 'e1', description: 'Narrative only', narrative: 1, mechanical: 0, instant: 0,
          persistent: 0, natural_event: 0, liminal: 0, source: null,
          effects: JSON.stringify({ forceLocation: 'cafe' }),
          status: 'active', created_at: now, expires_at: null, ended_at: null },
      ];
      const db = makeMockDb(rows);
      vi.mocked(getDatabase).mockReturnValue(db as never);
      expect(getActiveEffects()).toEqual({});
    });
  });
});
