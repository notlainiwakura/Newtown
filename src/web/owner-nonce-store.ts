/**
 * findings.md P2:2348 — owner session nonce store.
 *
 * Every v2 owner cookie carries a random nonce. This module persists the
 * nonce along with its issuance timestamp and (optionally) a device label,
 * and lets the server ask "is this nonce revoked?" when verifying a cookie.
 *
 * Storage authority is Wired Lain: rows live in WL's SQLite DB. Non-WL
 * servers (character, doctor) cannot read the table directly, so they call
 * the WL interlink endpoint and cache the answer in-memory with a short
 * fresh TTL + longer stale-grace window (same shape as the building-memory
 * resilience pattern, P2:1500). During a WL outage, non-WL servers serve
 * the last-known answer rather than flapping auth every isOwner() call.
 *
 * The helpers here are deliberately synchronous for the common case (cache
 * hit, or WL local DB read) so `isOwner(req)` can stay sync and not change
 * the shape of every call site in server.ts / character-server.ts.
 */

import { randomBytes } from 'node:crypto';
import { getDatabase } from '../storage/database.js';
import { getLogger } from '../utils/logger.js';
import { getWebCharacter } from '../config/characters.js';

const CACHE_FRESH_TTL_MS = 60_000;
const CACHE_STALE_GRACE_MS = 30 * 60_000;
const REFRESH_TIMEOUT_MS = 3_000;

interface CacheEntry {
  revoked: boolean;
  fetchedAt: number;
  fetchFailed: boolean;
}

const revocationCache = new Map<string, CacheEntry>();

let cacheHits = 0;
let cacheMisses = 0;
let cacheStaleServes = 0;

export function generateNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function isOwnerNonceAuthority(): boolean {
  const webCharacterId = getWebCharacter()?.id ?? 'wired-lain';
  return process.env['LAIN_CHARACTER_ID'] === webCharacterId;
}

function wiredLainUrl(): string {
  return process.env['WIRED_LAIN_URL'] ?? 'http://localhost:3000';
}

function interlinkToken(): string {
  return process.env['LAIN_INTERLINK_TOKEN'] ?? '';
}

// ---- Local DB accessors (Wired Lain only) ------------------------------

function localIssueNonce(nonce: string, issuedAt: number, deviceLabel: string | null): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO owner_nonces (nonce, issued_at, device_label, revoked_at) VALUES (?, ?, ?, NULL)'
  ).run(nonce, issuedAt, deviceLabel);
}

function localIsRevoked(nonce: string): boolean {
  const db = getDatabase();
  const row = db.prepare('SELECT revoked_at FROM owner_nonces WHERE nonce = ?').get(nonce) as
    | { revoked_at: number | null }
    | undefined;
  if (!row) return true; // unknown nonce = treat as revoked (forged or purged)
  return row.revoked_at !== null;
}

function localRevokeNonce(nonce: string): void {
  const db = getDatabase();
  db.prepare('UPDATE owner_nonces SET revoked_at = ? WHERE nonce = ? AND revoked_at IS NULL').run(Date.now(), nonce);
}

function localRevokeAll(): number {
  const db = getDatabase();
  const now = Date.now();
  const result = db.prepare('UPDATE owner_nonces SET revoked_at = ? WHERE revoked_at IS NULL').run(now);
  return result.changes;
}

// ---- HTTP accessors (non-WL servers) -----------------------------------

async function httpIsRevoked(nonce: string): Promise<boolean> {
  const url = `${wiredLainUrl()}/api/interlink/owner-nonce/${encodeURIComponent(nonce)}`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${interlinkToken()}` },
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (res.status === 404) return true; // unknown = revoked
  if (!res.ok) throw new Error(`owner-nonce check failed: ${res.status}`);
  const body = (await res.json()) as { revoked?: boolean };
  return Boolean(body.revoked);
}

async function httpRevokeNonce(nonce: string): Promise<void> {
  const url = `${wiredLainUrl()}/api/interlink/owner-nonce/${encodeURIComponent(nonce)}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${interlinkToken()}` },
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) throw new Error(`owner-nonce revoke failed: ${res.status}`);
}

async function httpRevokeAll(): Promise<number> {
  const url = `${wiredLainUrl()}/api/interlink/owner-nonces`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${interlinkToken()}` },
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`owner-nonces revoke-all failed: ${res.status}`);
  const body = (await res.json()) as { count?: number };
  return typeof body.count === 'number' ? body.count : 0;
}

// ---- Public API --------------------------------------------------------

/**
 * Issue a new nonce on the authoritative store. Only callable on the server
 * that owns the DB (Wired Lain). Returns the generated nonce; the caller
 * embeds it into the cookie payload.
 */
export function issueNonce(deviceLabel: string | null = null): string {
  if (!isOwnerNonceAuthority()) {
    throw new Error('issueNonce must be called on Wired Lain (authoritative owner-nonce store)');
  }
  const nonce = generateNonce();
  localIssueNonce(nonce, Date.now(), deviceLabel);
  // Seed the cache with the fresh state so immediate verify calls on this
  // process don't round-trip through the DB again.
  revocationCache.set(nonce, { revoked: false, fetchedAt: Date.now(), fetchFailed: false });
  return nonce;
}

/**
 * Synchronous revocation check. Returns `true` if the cookie must be
 * rejected (revoked OR unknown), `false` if it's currently valid. The
 * function never awaits: cache-miss on a non-WL server schedules a
 * background refresh and, to preserve the pre-P2:2348 behaviour on first
 * sight of an unknown nonce, assumes NOT revoked for the first call. If
 * the refresh returns "revoked/unknown," subsequent calls reject.
 *
 * This trades a small revocation-propagation window (≤ refresh latency)
 * for keeping `isOwner(req)` sync across every call site.
 */
export function isNonceRevoked(nonce: string): boolean {
  if (isOwnerNonceAuthority()) return localIsRevoked(nonce);

  const entry = revocationCache.get(nonce);
  const now = Date.now();
  if (entry) {
    const age = now - entry.fetchedAt;
    if (age <= CACHE_FRESH_TTL_MS) {
      cacheHits++;
      return entry.revoked;
    }
    if (entry.fetchFailed && age <= CACHE_STALE_GRACE_MS) {
      cacheStaleServes++;
      // Opportunistically try again in the background.
      scheduleRefresh(nonce);
      return entry.revoked;
    }
  }
  cacheMisses++;
  scheduleRefresh(nonce);
  // First-sight optimism: assume valid until we hear otherwise. The
  // alternative (pessimistic "reject until refresh completes") would make
  // every fresh owner session bounce on first use.
  return entry?.revoked ?? false;
}

const refreshInFlight = new Set<string>();

function scheduleRefresh(nonce: string): void {
  if (refreshInFlight.has(nonce)) return;
  refreshInFlight.add(nonce);
  queueMicrotask(async () => {
    try {
      const revoked = await httpIsRevoked(nonce);
      revocationCache.set(nonce, { revoked, fetchedAt: Date.now(), fetchFailed: false });
    } catch (err) {
      const prior = revocationCache.get(nonce);
      if (prior) {
        revocationCache.set(nonce, { ...prior, fetchFailed: true });
      } else {
        revocationCache.set(nonce, { revoked: false, fetchedAt: Date.now(), fetchFailed: true });
      }
      getLogger().warn({ err }, 'owner-nonce refresh failed (serving last-known)');
    } finally {
      refreshInFlight.delete(nonce);
    }
  });
}

/** Authoritative: revoke a single nonce (Wired Lain only). */
export function revokeNonce(nonce: string): void {
  if (!isOwnerNonceAuthority()) {
    throw new Error('revokeNonce must be called on Wired Lain (authoritative owner-nonce store)');
  }
  localRevokeNonce(nonce);
  revocationCache.set(nonce, { revoked: true, fetchedAt: Date.now(), fetchFailed: false });
}

/** Authoritative: revoke EVERY nonce — "log me out everywhere." */
export function revokeAllNonces(): number {
  if (!isOwnerNonceAuthority()) {
    throw new Error('revokeAllNonces must be called on Wired Lain (authoritative owner-nonce store)');
  }
  const count = localRevokeAll();
  revocationCache.clear();
  return count;
}

/**
 * Revoke a nonce regardless of which server we're on. WL revokes locally;
 * mortals proxy through the interlink endpoint. Used by `/owner/logout`,
 * which any character server may receive (the cookie is portable because
 * LAIN_OWNER_TOKEN is shared).
 */
export async function revokeNonceOnAuthority(nonce: string): Promise<void> {
  if (isOwnerNonceAuthority()) {
    revokeNonce(nonce);
    return;
  }
  await httpRevokeNonce(nonce);
  revocationCache.set(nonce, { revoked: true, fetchedAt: Date.now(), fetchFailed: false });
}

/** `/owner/logout-all` companion to `revokeNonceOnAuthority`. */
export async function revokeAllOnAuthority(): Promise<number> {
  if (isOwnerNonceAuthority()) return revokeAllNonces();
  const count = await httpRevokeAll();
  revocationCache.clear();
  return count;
}

/** List active nonces (Wired Lain only), for the dashboard. */
export function listActiveNonces(): Array<{ nonce: string; issuedAt: number; deviceLabel: string | null }> {
  if (!isOwnerNonceAuthority()) return [];
  const db = getDatabase();
  const rows = db
    .prepare('SELECT nonce, issued_at as issuedAt, device_label as deviceLabel FROM owner_nonces WHERE revoked_at IS NULL ORDER BY issued_at DESC')
    .all() as Array<{ nonce: string; issuedAt: number; deviceLabel: string | null }>;
  return rows;
}

export function getOwnerNonceHealth(): {
  cacheSize: number;
  cacheHits: number;
  cacheMisses: number;
  cacheStaleServes: number;
  refreshesInFlight: number;
} {
  return {
    cacheSize: revocationCache.size,
    cacheHits,
    cacheMisses,
    cacheStaleServes,
    refreshesInFlight: refreshInFlight.size,
  };
}

/** Test-only: wipe caches between cases. */
export function _resetOwnerNonceStoreForTests(): void {
  revocationCache.clear();
  refreshInFlight.clear();
  cacheHits = 0;
  cacheMisses = 0;
  cacheStaleServes = 0;
}
