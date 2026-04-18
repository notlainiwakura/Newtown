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

// --- Remote embedding proxy ---
const EMBEDDING_SERVICE_URL = process.env['EMBEDDING_SERVICE_URL'];
const EMBEDDING_SERVICE_KEY = process.env['LAIN_WEB_API_KEY'] || '';

async function generateEmbeddingRemote(text: string): Promise<Float32Array> {
  const resp = await fetch(`${EMBEDDING_SERVICE_URL}?key=${encodeURIComponent(EMBEDDING_SERVICE_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!resp.ok) throw new Error(`Embedding service error: ${resp.status}`);
  const data = await resp.json() as { embeddings: number[][] };
  return new Float32Array(data.embeddings[0]!);
}

async function generateEmbeddingsRemote(texts: string[]): Promise<Float32Array[]> {
  const resp = await fetch(`${EMBEDDING_SERVICE_URL}?key=${encodeURIComponent(EMBEDDING_SERVICE_KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
 * Initialize the embedding model (lazy loaded)
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
    logger.info({ model: MODEL_NAME }, 'Loading embedding model');

    const pipe = await pipeline('feature-extraction', MODEL_NAME, {
      quantized: true, // Use quantized model for faster inference
    });

    embeddingPipeline = pipe;
    isLoading = false;
    logger.info({ model: MODEL_NAME }, 'Embedding model loaded');

    return pipe;
  })();

  return loadPromise;
}

/**
 * Generate embeddings for a single text
 */
export async function generateEmbedding(text: string): Promise<Float32Array> {
  if (EMBEDDING_SERVICE_URL) return generateEmbeddingRemote(text);

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
