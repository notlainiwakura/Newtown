/**
 * Relationship system tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock keytar before any imports that touch storage
vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn().mockResolvedValue('test-master-key'),
    setPassword: vi.fn().mockResolvedValue(undefined),
    deletePassword: vi.fn().mockResolvedValue(true),
    findCredentials: vi.fn().mockResolvedValue([]),
  },
}));

import {
  initDatabase,
  closeDatabase,
} from '../src/storage/database.js';

import {
  getRelationship,
  saveRelationshipData,
  getAllRelationships,
  getRelationshipContext,
  type Relationship,
} from '../src/agent/relationships.js';

describe('Relationship System', () => {
  const testDir = join(tmpdir(), `lain-test-rel-${Date.now()}`);
  const dbPath = join(testDir, 'test.db');
  const originalEnv = process.env['LAIN_HOME'];

  beforeEach(async () => {
    process.env['LAIN_HOME'] = testDir;
    await mkdir(testDir, { recursive: true });
    await initDatabase(dbPath);
  });

  afterEach(async () => {
    closeDatabase();
    if (originalEnv) {
      process.env['LAIN_HOME'] = originalEnv;
    } else {
      delete process.env['LAIN_HOME'];
    }
    try {
      await rm(testDir, { recursive: true });
    } catch {
      // Ignore
    }
  });

  describe('getRelationship', () => {
    it('should return null for unknown peer', () => {
      const result = getRelationship('nonexistent-peer');
      expect(result).toBeNull();
    });

    it('should return saved relationship', () => {
      const rel: Relationship = {
        peerId: 'pkd',
        peerName: 'Philip K. Dick',
        affinity: 0.7,
        familiarity: 0.3,
        intellectual_tension: 0.6,
        emotional_resonance: 0.4,
        last_topic_thread: 'simulacra and simulation',
        unresolved: 'whether androids dream',
        last_interaction: 1000,
        interaction_count: 5,
      };

      saveRelationshipData('pkd', rel);
      const loaded = getRelationship('pkd');

      expect(loaded).not.toBeNull();
      expect(loaded!.peerId).toBe('pkd');
      expect(loaded!.peerName).toBe('Philip K. Dick');
      expect(loaded!.affinity).toBe(0.7);
      expect(loaded!.familiarity).toBe(0.3);
      expect(loaded!.last_topic_thread).toBe('simulacra and simulation');
      expect(loaded!.unresolved).toBe('whether androids dream');
      expect(loaded!.interaction_count).toBe(5);
    });
  });

  describe('saveRelationshipData', () => {
    it('should save and retrieve a relationship', () => {
      const rel: Relationship = {
        peerId: 'mckenna',
        peerName: 'Terence McKenna',
        affinity: 0.8,
        familiarity: 0.5,
        intellectual_tension: 0.9,
        emotional_resonance: 0.6,
        last_topic_thread: 'psychedelics and consciousness',
        unresolved: null,
        last_interaction: Date.now(),
        interaction_count: 3,
      };

      saveRelationshipData('mckenna', rel);
      const loaded = getRelationship('mckenna');

      expect(loaded).not.toBeNull();
      expect(loaded!.peerId).toBe('mckenna');
      expect(loaded!.affinity).toBe(0.8);
    });

    it('should enforce familiarity only increases', () => {
      const initial: Relationship = {
        peerId: 'john',
        peerName: 'John',
        affinity: 0.5,
        familiarity: 0.6,
        intellectual_tension: 0.4,
        emotional_resonance: 0.3,
        last_topic_thread: 'common sense',
        unresolved: null,
        last_interaction: 1000,
        interaction_count: 2,
      };

      saveRelationshipData('john', initial);

      // Try to save with lower familiarity
      const updated: Relationship = {
        ...initial,
        familiarity: 0.3, // lower than 0.6
        affinity: 0.9,    // other fields can change freely
      };

      saveRelationshipData('john', updated);
      const loaded = getRelationship('john');

      expect(loaded).not.toBeNull();
      expect(loaded!.familiarity).toBe(0.6); // should stay at 0.6, not drop to 0.3
      expect(loaded!.affinity).toBe(0.9);    // other fields should update normally
    });

    it('should allow familiarity to increase', () => {
      const initial: Relationship = {
        peerId: 'john',
        peerName: 'John',
        affinity: 0.5,
        familiarity: 0.3,
        intellectual_tension: 0.4,
        emotional_resonance: 0.3,
        last_topic_thread: 'plain talk',
        unresolved: null,
        last_interaction: 1000,
        interaction_count: 1,
      };

      saveRelationshipData('john', initial);

      const updated: Relationship = {
        ...initial,
        familiarity: 0.5,
      };

      saveRelationshipData('john', updated);
      const loaded = getRelationship('john');

      expect(loaded).not.toBeNull();
      expect(loaded!.familiarity).toBe(0.5);
    });
  });

  describe('getAllRelationships', () => {
    it('should return empty array when no relationships exist', () => {
      const all = getAllRelationships();
      expect(all).toEqual([]);
    });

    it('should return all saved relationships', () => {
      const relA: Relationship = {
        peerId: 'pkd',
        peerName: 'Philip K. Dick',
        affinity: 0.6,
        familiarity: 0.4,
        intellectual_tension: 0.7,
        emotional_resonance: 0.5,
        last_topic_thread: 'reality',
        unresolved: null,
        last_interaction: 1000,
        interaction_count: 2,
      };

      const relB: Relationship = {
        peerId: 'mckenna',
        peerName: 'Terence McKenna',
        affinity: 0.8,
        familiarity: 0.3,
        intellectual_tension: 0.9,
        emotional_resonance: 0.6,
        last_topic_thread: 'novelty theory',
        unresolved: 'timewave zero accuracy',
        last_interaction: 2000,
        interaction_count: 1,
      };

      saveRelationshipData('pkd', relA);
      saveRelationshipData('mckenna', relB);

      const all = getAllRelationships();
      expect(all).toHaveLength(2);

      const peerIds = all.map((r) => r.peerId).sort();
      expect(peerIds).toEqual(['mckenna', 'pkd']);
    });
  });

  describe('getRelationshipContext', () => {
    it('should return no-relationship message for unknown peer', () => {
      const ctx = getRelationshipContext('nobody');
      expect(ctx).toContain('No prior relationship');
    });

    it('should generate context string with relationship data', () => {
      const rel: Relationship = {
        peerId: 'pkd',
        peerName: 'Philip K. Dick',
        affinity: 0.8,
        familiarity: 0.75,
        intellectual_tension: 0.6,
        emotional_resonance: 0.5,
        last_topic_thread: 'VALIS and pink light',
        unresolved: 'the nature of Zebra',
        last_interaction: Date.now(),
        interaction_count: 10,
      };

      saveRelationshipData('pkd', rel);
      const ctx = getRelationshipContext('pkd');

      expect(ctx).toContain('Philip K. Dick');
      expect(ctx).toContain('warm');
      expect(ctx).toContain('deeply known');
      expect(ctx).toContain('VALIS and pink light');
      expect(ctx).toContain('the nature of Zebra');
      expect(ctx).toContain('10 conversations');
    });

    it('should show correct labels for different affinity levels', () => {
      const base: Relationship = {
        peerId: 'test',
        peerName: 'Test',
        affinity: 0.2,
        familiarity: 0.1,
        intellectual_tension: 0.5,
        emotional_resonance: 0.5,
        last_topic_thread: '',
        unresolved: null,
        last_interaction: 1000,
        interaction_count: 1,
      };

      // Cool affinity
      saveRelationshipData('test', { ...base, affinity: 0.2 });
      expect(getRelationshipContext('test')).toContain('cool');

      // Neutral affinity
      saveRelationshipData('test', { ...base, affinity: 0.5 });
      expect(getRelationshipContext('test')).toContain('neutral');

      // Warm affinity
      saveRelationshipData('test', { ...base, affinity: 0.8 });
      expect(getRelationshipContext('test')).toContain('warm');
    });
  });
});
