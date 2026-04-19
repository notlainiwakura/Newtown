/**
 * Optional ChromaDB mirror for persisted memories.
 * Local SQLite remains the source of truth; this mirror is best-effort only.
 */

import { eventBus } from '../events/bus.js';
import { getLogger } from '../utils/logger.js';

type ScalarValue = string | number | boolean;
type ChromaMetadataValue = ScalarValue | string[] | number[] | boolean[];

export interface ChromaMirrorConfig {
  baseUrl: string;
  tenant: string;
  database: string;
  collectionPrefix: string;
  timeoutMs: number;
}

export interface MirroredMemoryRecord {
  id: string;
  characterId?: string | null;
  sessionKey: string | null;
  userId: string | null;
  content: string;
  memoryType: 'fact' | 'preference' | 'context' | 'summary' | 'episode';
  importance: number;
  emotionalWeight: number;
  embedding: Float32Array | null;
  createdAt: number;
  relatedTo: string | null;
  sourceMessageId: string | null;
  metadata: Record<string, unknown>;
  lifecycleState: string;
  phase: string | null;
  wingId: string | null;
  roomId: string | null;
  hall: string | null;
}

export interface ChromaMirrorOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof globalThis.fetch;
  logger?: Pick<ReturnType<typeof getLogger>, 'debug'>;
}

const DEFAULT_TENANT = 'default_tenant';
const DEFAULT_DATABASE = 'default_database';
const DEFAULT_COLLECTION_PREFIX = 'newtown-memory';
const DEFAULT_TIMEOUT_MS = 4000;

const collectionIdCache = new Map<string, Promise<string>>();

export function clearChromaCollectionCache(): void {
  collectionIdCache.clear();
}

export function getChromaMirrorConfig(env: NodeJS.ProcessEnv = process.env): ChromaMirrorConfig | null {
  const rawBaseUrl = env['CHROMA_BASE_URL']?.trim();
  const enabledValue = env['CHROMA_MIRROR_ENABLED']?.trim();
  const enabled = enabledValue
    ? enabledValue === '1' || enabledValue.toLowerCase() === 'true'
    : Boolean(rawBaseUrl);

  if (!enabled || !rawBaseUrl) {
    return null;
  }

  const timeoutMs = parsePositiveInt(env['CHROMA_TIMEOUT_MS']) ?? DEFAULT_TIMEOUT_MS;

  return {
    baseUrl: rawBaseUrl.replace(/\/+$/, ''),
    tenant: env['CHROMA_TENANT']?.trim() || DEFAULT_TENANT,
    database: env['CHROMA_DATABASE']?.trim() || DEFAULT_DATABASE,
    collectionPrefix: sanitizeCollectionSegment(env['CHROMA_COLLECTION_PREFIX']?.trim() || DEFAULT_COLLECTION_PREFIX),
    timeoutMs,
  };
}

export function resolveChromaCollectionName(
  characterId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const config = getChromaMirrorConfig(env);
  const prefix = config?.collectionPrefix ?? DEFAULT_COLLECTION_PREFIX;
  const characterSegment = sanitizeCollectionSegment(characterId);
  return characterSegment ? `${prefix}-${characterSegment}` : prefix;
}

export function sanitizeChromaMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, ChromaMetadataValue> {
  const sanitized: Record<string, ChromaMetadataValue> = {};
  if (!metadata) {
    return sanitized;
  }

  for (const [key, value] of Object.entries(metadata)) {
    const normalizedKey = sanitizeMetadataKey(key);
    if (!normalizedKey) {
      continue;
    }

    const normalizedValue = normalizeMetadataValue(value);
    if (normalizedValue !== undefined) {
      sanitized[normalizedKey] = normalizedValue;
    }
  }

  return sanitized;
}

export async function mirrorMemoryToChroma(
  memory: MirroredMemoryRecord,
  options: ChromaMirrorOptions = {}
): Promise<void> {
  const config = getChromaMirrorConfig(options.env);
  if (!config || !memory.embedding || memory.embedding.length === 0) {
    return;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? getLogger();
  const characterId = resolveCharacterId(memory.characterId);
  const collectionName = resolveChromaCollectionName(characterId, options.env);
  const collectionId = await ensureCollectionId(collectionName, characterId, config, fetchImpl);

  const response = await fetchImpl(
    `${config.baseUrl}/api/v2/tenants/${encodeURIComponent(config.tenant)}/databases/${encodeURIComponent(config.database)}/collections/${encodeURIComponent(collectionId)}/upsert`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ids: [memory.id],
        embeddings: [Array.from(memory.embedding, (value) => (Number.isFinite(value) ? value : 0))],
        documents: [memory.content],
        metadatas: [buildChromaMetadata(memory, characterId)],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    }
  );

  if (!response.ok) {
    throw new Error(`Chroma upsert failed (${response.status}): ${await readResponseText(response)}`);
  }

  logger.debug({ memoryId: memory.id, characterId, collectionName }, 'Mirrored memory to Chroma');
}

function buildChromaMetadata(
  memory: MirroredMemoryRecord,
  characterId: string
): Record<string, ChromaMetadataValue> {
  const metadata: Record<string, ChromaMetadataValue> = {
    characterId,
    memoryType: memory.memoryType,
    importance: memory.importance,
    emotionalWeight: memory.emotionalWeight,
    createdAt: memory.createdAt,
    createdAtIso: new Date(memory.createdAt).toISOString(),
    lifecycleState: memory.lifecycleState,
  };

  addOptionalString(metadata, 'sessionKey', memory.sessionKey);
  addOptionalString(metadata, 'userId', memory.userId);
  addOptionalString(metadata, 'relatedTo', memory.relatedTo);
  addOptionalString(metadata, 'sourceMessageId', memory.sourceMessageId);
  addOptionalString(metadata, 'phase', memory.phase);
  addOptionalString(metadata, 'wingId', memory.wingId);
  addOptionalString(metadata, 'roomId', memory.roomId);
  addOptionalString(metadata, 'hall', memory.hall);

  const extraMetadata = sanitizeChromaMetadata(memory.metadata);
  for (const [key, value] of Object.entries(extraMetadata)) {
    metadata[`meta_${key}`] = value;
  }

  return metadata;
}

async function ensureCollectionId(
  collectionName: string,
  characterId: string,
  config: ChromaMirrorConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string> {
  const cacheKey = `${config.baseUrl}|${config.tenant}|${config.database}|${collectionName}`;
  const existing = collectionIdCache.get(cacheKey);
  if (existing) {
    return existing;
  }

  const pending = createOrGetCollection(collectionName, characterId, config, fetchImpl);
  collectionIdCache.set(cacheKey, pending);

  try {
    return await pending;
  } catch (error) {
    collectionIdCache.delete(cacheKey);
    throw error;
  }
}

async function createOrGetCollection(
  collectionName: string,
  characterId: string,
  config: ChromaMirrorConfig,
  fetchImpl: typeof globalThis.fetch
): Promise<string> {
  const response = await fetchImpl(
    `${config.baseUrl}/api/v2/tenants/${encodeURIComponent(config.tenant)}/databases/${encodeURIComponent(config.database)}/collections`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: collectionName,
        get_or_create: true,
        metadata: {
          source: 'newtown-memory-mirror',
          characterId,
        },
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    }
  );

  if (!response.ok) {
    throw new Error(`Chroma collection ensure failed (${response.status}): ${await readResponseText(response)}`);
  }

  const data = await response.json() as { id?: string };
  if (!data.id) {
    throw new Error(`Chroma collection ensure returned no id for ${collectionName}`);
  }

  return data.id;
}

function resolveCharacterId(characterId: string | null | undefined): string {
  return characterId?.trim() || process.env['LAIN_CHARACTER_ID'] || eventBus.characterId || 'newtown';
}

function addOptionalString(
  target: Record<string, ChromaMetadataValue>,
  key: string,
  value: string | null
): void {
  if (value) {
    target[key] = value;
  }
}

function normalizeMetadataValue(value: unknown): ChromaMetadataValue | undefined {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return normalizeArrayMetadata(value);
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  return safeJsonStringify(value);
}

function normalizeArrayMetadata(value: unknown[]): ChromaMetadataValue {
  if (value.length === 0) {
    return '[]';
  }

  if (value.every((entry) => typeof entry === 'string')) {
    return value as string[];
  }

  if (value.every((entry) => typeof entry === 'boolean')) {
    return value as boolean[];
  }

  if (value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return value as number[];
  }

  return safeJsonStringify(value);
}

function sanitizeMetadataKey(key: string): string {
  return key
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function sanitizeCollectionSegment(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return sanitized || 'memory';
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}
