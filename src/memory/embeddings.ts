/**
 * Local embeddings using transformers.js
 * Runs entirely locally - no external API calls
 *
 * When EMBEDDING_SERVICE_URL is set, proxies requests to a shared
 * embedding service instead of loading the model locally.
 */

import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';
import { getLogger } from '../utils/logger.js';

let embeddingPipeline: FeatureExtractionPipeline | null = null;
let isLoading = false;
let loadPromise: Promise<FeatureExtractionPipeline> | null = null;

// Use a small but effective model for embeddings
const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

/**
 * findings.md P2:517 — the `memories.embedding_model` column stores the
 * string identifier of whichever model generated each row's vector, so
 * we can detect model drift instead of silently comparing cosines across
 * two embedding spaces (which yields garbage similarity with no error).
 *
 * Exported so storage-side code can stamp new writes, and so search-side
 * code can filter out rows whose stamp no longer matches the current
 * model. Legacy pre-migration rows carry NULL; we treat those as "unknown
 * but presumed current" until/unless the model is deliberately swapped.
 */
export const CURRENT_EMBEDDING_MODEL = MODEL_NAME;

/**
 * findings.md P2:505 — MiniLM's tokenizer has a 512-token hard cap and
 * the pipeline silently truncates anything longer. For English prose the
 * ratio is ~4 chars per token, so content over ~2000 characters starts
 * losing material from the tail. A 4000-char curiosity discovery would
 * get an embedding computed from only its first third — the similarity
 * vector then reflects a preamble rather than the payload, and search
 * for concepts mentioned later in the text misses the memory entirely.
 *
 * We don't chunk-and-average (that would silently change search
 * semantics and require backfill); instead we emit an observable warn
 * so operators can see it happening, and expose `isLikelyTruncated` so
 * callers (e.g. extraction, curiosity) can pre-check and shorten.
 */
export const EMBEDDING_CHAR_BUDGET = 2000;

export function isLikelyTruncated(text: string): boolean {
  return text.length > EMBEDDING_CHAR_BUDGET;
}

function warnIfTruncated(text: string, context: string): void {
  if (text.length > EMBEDDING_CHAR_BUDGET) {
    getLogger().warn(
      {
        context,
        charLength: text.length,
        budget: EMBEDDING_CHAR_BUDGET,
        model: MODEL_NAME,
      },
      'Embedding input likely truncated by 512-token cap — similarity will reflect only the head',
    );
  }
}

// --- Remote embedding proxy ---
const EMBEDDING_SERVICE_URL = process.env['EMBEDDING_SERVICE_URL'];
const EMBEDDING_SERVICE_KEY = process.env['LAIN_WEB_API_KEY'] || '';

/**
 * findings.md P2:467 — API key used to be sent as `?key=<secret>` in the
 * URL. Request-line URLs are commonly logged by HTTP proxies, CDNs,
 * reverse proxies, and web server access logs, so the key ended up in
 * plaintext in those logs. We now send it as `Authorization: Bearer`,
 * which matches the server's existing `verifyApiAuth` path and keeps
 * the secret out of URL-based telemetry.
 */
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (EMBEDDING_SERVICE_KEY) {
    headers['Authorization'] = `Bearer ${EMBEDDING_SERVICE_KEY}`;
  }
  return headers;
}

async function generateEmbeddingRemote(text: string): Promise<Float32Array> {
  warnIfTruncated(text, 'generateEmbedding:remote');
  const resp = await fetch(EMBEDDING_SERVICE_URL!, {
    method: 'POST',
    headers: buildAuthHeaders(),
    body: JSON.stringify({ texts: [text] }),
  });
  if (!resp.ok) throw new Error(`Embedding service error: ${resp.status}`);
  const data = await resp.json() as { embeddings: number[][] };
  return new Float32Array(data.embeddings[0]!);
}

async function generateEmbeddingsRemote(texts: string[]): Promise<Float32Array[]> {
  for (const t of texts) warnIfTruncated(t, 'generateEmbeddings:remote');
  const resp = await fetch(EMBEDDING_SERVICE_URL!, {
    method: 'POST',
    headers: buildAuthHeaders(),
    body: JSON.stringify({ texts }),
  });
  if (!resp.ok) throw new Error(`Embedding service error: ${resp.status}`);
  const data = await resp.json() as { embeddings: number[][] };
  return data.embeddings.map(e => new Float32Array(e));
}

// --- Idle unload timer ---
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export function unloadEmbeddingModel(): void {
  embeddingPipeline = null;
  loadPromise = null;
  isLoading = false;
}

function resetIdleTimer(): void {
  if (EMBEDDING_SERVICE_URL) return; // Remote mode, nothing to unload
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(unloadEmbeddingModel, IDLE_TIMEOUT_MS);
}

/**
 * Initialize the embedding model (lazy loaded).
 *
 * findings.md P2:477 — prior version set `isLoading = false` only on
 * the resolve path, so a rejected load left `loadPromise` and
 * `isLoading` permanently set. Every subsequent call returned the same
 * rejected promise, disabling embedding generation until process
 * restart. Now the async IIFE clears `loadPromise`/`isLoading` in a
 * `finally` (or on the throw path) so transient first-load failures
 * (HuggingFace CDN glitch, disk full during model download, extension
 * load failure) are self-healing — the next call retries.
 */
async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  if (loadPromise) {
    return loadPromise;
  }

  const logger = getLogger();
  isLoading = true;

  loadPromise = (async () => {
    try {
      logger.info({ model: MODEL_NAME }, 'Loading embedding model');

      const pipe = await pipeline('feature-extraction', MODEL_NAME, {
        quantized: true, // Use quantized model for faster inference
      });

      embeddingPipeline = pipe;
      logger.info({ model: MODEL_NAME }, 'Embedding model loaded');
      return pipe;
    } catch (error) {
      // findings.md P2:477 — reset both `loadPromise` and `isLoading`
      // so a transient failure does not permanently poison the
      // singleton. Log before rethrowing so the failure is visible.
      logger.warn({ error, model: MODEL_NAME }, 'Embedding model load failed; next call will retry');
      loadPromise = null;
      throw error;
    } finally {
      isLoading = false;
    }
  })();

  return loadPromise;
}

/**
 * Generate embeddings for a single text
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (EMBEDDING_SERVICE_URL) return generateEmbeddingRemote(text);

  warnIfTruncated(text, 'generateEmbedding:local');

  const pipe = await getEmbeddingPipeline();

  // Generate embedding
  const output = await pipe(text, {
    pooling: 'mean',
    normalize: true,
  });

  // Convert to Float32Array - handle various output types
  const data = output.data as unknown as ArrayLike<number>;
  resetIdleTimer();
  return new Float32Array(Array.from(data));
}

/**
 * Generate embeddings for multiple texts (batched)
 */
export async function generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }

  if (EMBEDDING_SERVICE_URL) return generateEmbeddingsRemote(texts);

  for (const t of texts) warnIfTruncated(t, 'generateEmbeddings:local');

  const pipe = await getEmbeddingPipeline();
  const results: Float32Array[] = [];

  // Process in batches to avoid memory issues
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    for (const text of batch) {
      const output = await pipe(text, {
        pooling: 'mean',
        normalize: true,
      });
      const data = output.data as unknown as ArrayLike<number>;
      results.push(new Float32Array(Array.from(data)));
    }
  }

  resetIdleTimer();
  return results;
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error('Embeddings must have same dimensions');
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Find top-k most similar embeddings
 */
export function findTopK(
  query: Float32Array,
  candidates: { id: string; embedding: Float32Array }[],
  k: number
): { id: string; similarity: number }[] {
  const scored = candidates.map((c) => ({
    id: c.id,
    similarity: cosineSimilarity(query, c.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, k);
}

/**
 * Compute the centroid (element-wise mean, L2-normalized) of a set of embeddings.
 * Used for coherence group signatures.
 */
export function computeCentroid(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) {
    return new Float32Array(EMBEDDING_DIM);
  }

  const dim = embeddings[0]!.length;
  const sum = new Float32Array(dim);

  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      sum[i]! += emb[i]!;
    }
  }

  // Mean
  const count = embeddings.length;
  for (let i = 0; i < dim; i++) {
    sum[i]! /= count;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += sum[i]! * sum[i]!;
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      sum[i]! /= norm;
    }
  }

  return sum;
}

/**
 * Check if embedding model is loaded
 */
export function isEmbeddingModelLoaded(): boolean {
  return embeddingPipeline !== null;
}

/**
 * Check if embedding model is currently loading
 */
export function isEmbeddingModelLoading(): boolean {
  return isLoading;
}

/**
 * Get embedding dimensions
 */
export function getEmbeddingDimensions(): number {
  return EMBEDDING_DIM;
}

/**
 * Serialize embedding to buffer for database storage
 */
export function serializeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer);
}

/**
 * Deserialize embedding from database buffer
 */
export function deserializeEmbedding(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
}
