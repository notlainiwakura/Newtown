# `src/memory/embeddings.ts`

Local transformers.js pipeline OR remote proxy. 11 exports. 384-dim `all-MiniLM-L6-v2`.

## Functions

### `generateEmbeddingRemote(text)`, line 24 / `generateEmbeddingsRemote(texts)`, line 35

POST to `EMBEDDING_SERVICE_URL` with `?key=...`.

**Gaps / bugs:**
- **API key in query string.** `?key=${encodeURIComponent(EMBEDDING_SERVICE_KEY)}` puts the key in request-line URLs, which are commonly logged by proxies, CDNs, and server access logs. Authorization header is the standard. **P2 — lift**.
- No timeout on `fetch()`. A hung embedding service blocks every memory write. Ties to the `withTimeout` no-abort P2. **P2**.
- `data.embeddings[0]!` — non-null assertion. An empty array response (e.g. upstream bug) crashes with a cryptic "undefined is not iterable". **P3**.
- No retry — a single transient failure of the embedding service throws up through `saveMemory` → `try/catch` → memory is saved with null embedding and the vec0 index misses this row forever. Ties to the store.ts vec0 divergence P2. **P3**.

### `unloadEmbeddingModel()`, line 50

Drops reference to pipeline. GC picks up the ~100MB model.

**Gaps / bugs:**
- Does NOT clear any in-flight `pipe(text)` call. If an embedding is mid-inference when unload fires, the pipeline reference is dropped but the inference continues on the old pipeline (since the caller holds the `pipe` local). OK, but worth noting.

### `resetIdleTimer()`, line 56

Schedules unload after 5 minutes of idle.

**Gaps / bugs:**
- 5-minute timeout is aggressive. A character that writes a memory, then 6 minutes later writes another, re-loads the ~100MB model. Load time is not trivial (~2-5s). **P3** — tune.
- Called from `generateEmbedding` and `generateEmbeddings` AFTER the await. If the generate throws, the idle timer isn't reset. Fine — the next call re-resets. **No bug.**

### `getEmbeddingPipeline()`, line 65

Lazy singleton with `loadPromise` to serialize concurrent first-loads.

**Gaps / bugs:**
- `isLoading = true` flag is a local boolean; also set to `false` AFTER the load resolves. If load fails, `isLoading` stays `true` and `loadPromise` stays assigned. Future calls see `loadPromise` truthy and return the rejected promise — every subsequent call re-rejects forever until restart. **P2 — lift.**
- No retry on first-load failure (network glitch to huggingface CDN, disk full during model download).

### `generateEmbedding(text)`, line 97

Per-text inference.

**Gaps / bugs:**
- `Array.from(data)` → `new Float32Array(...)` converts via a plain JS array. One unnecessary copy. Could `new Float32Array(output.data.buffer, output.data.byteOffset, output.data.length)`. **P3.**
- No input length check. Pipeline has its own token cap (512 for MiniLM); inputs longer than that get silently truncated by the tokenizer. Memories with long content get an embedding of their first ~400 words only. **P2 — lift**: long memories have misleading embeddings.

### `generateEmbeddings(texts)`, line 117

Batch wrapper. Batches by 32, but within each batch still calls `pipe(text)` serially (not vectorized).

**Gaps / bugs:**
- **`batchSize = 32` variable is cosmetic** — the inner loop is still one-at-a-time. No actual batching happens. Either drop the `batchSize` complexity or actually batch via `pipe(texts, ...)`. **P3.**
- Same token-cap silent-truncation as above.

### `cosineSimilarity(a, b)`, line 149

Standard cosine. Length check throws.

**Gaps / bugs:**
- `a[i] ?? 0` — Float32Array indices always return a number, never undefined. The noUncheckedIndexedAccess TS option makes this needed at compile time but wastes cycles at runtime. Fine. **No bug.**
- If either vector has magnitude 0 (e.g. un-normalized zero vector), returns 0 safely.

### `findTopK(query, candidates, k)`, line 175

Sort + slice. Simple. O(N log N). Fine.

### `computeCentroid(embeddings)`, line 194

Element-wise mean + L2 normalize. Used for coherence group signatures.

**Gaps / bugs:**
- `new Float32Array(EMBEDDING_DIM)` default for empty input — returns zero-vector. A consumer checking `cosineSimilarity(query, centroid)` gets 0 for everything. OK as long as callers check `embeddings.length > 0` before calling.

### `isEmbeddingModelLoaded()`, `isEmbeddingModelLoading()`, `getEmbeddingDimensions()`, lines 233-249

Trivial getters. Fine.

### `serializeEmbedding(embedding)`, line 254

`Buffer.from(embedding.buffer)`.

**Gaps / bugs:**
- **Uses the Float32Array's underlying buffer directly**, which may be a SHARED buffer if the Float32Array was constructed via a buffer slice (e.g. `deserializeEmbedding` returns a view onto the input buffer). Round-tripping a deserialized embedding and re-serializing it would include the original buffer's full bytes if the Float32Array is a partial view. The typical path (generateEmbedding → saveMemory → serialize) produces a standalone Float32Array so this doesn't bite today. **P3 — latent.**

### `deserializeEmbedding(buffer)`, line 261

Returns a Float32Array view over the input buffer, NOT a copy.

**Gaps / bugs:**
- **View, not copy.** If the caller mutates the returned Float32Array (e.g. during normalization), the underlying SQLite-returned Buffer is also mutated. better-sqlite3 returns independent Buffer objects per row, so this is probably fine for read-only consumers, but there's no invariant enforcing it. **P3 — latent.**
- `buffer.length / 4` — buffer length in bytes, divided by 4 (size of float32). Integer truncation drops half-floats if the buffer is misaligned. Shouldn't happen with the serializer above. **No bug** in practice.

---

## File-level notes

- **No versioning on embedding model.** Memories created with `Xenova/all-MiniLM-L6-v2` are stored alongside memories from any future model switch. Queries mix old and new embeddings, producing garbage similarity. The schema doesn't track which model generated which embedding. **P2 — lift**: no embedding model versioning.
- **No warm-up option for startup.** First embedding after cold boot or idle unload takes 2-5s. Character servers could `getEmbeddingPipeline()` at startup to pre-warm, but no one does. **P3.**
- `MODEL_NAME` is a const. No way to configure per-character. Characters with different content types (ASCII art, code, non-English) would benefit from different models. **P3** — ties to `ProviderConfig` tunables P2.
- `EMBEDDING_DIM = 384` is hard-coded. Matches vec0 schema (`vec0(embedding float[384], ...)` from `storage/database.ts`). If the model changes, two places to update — document in a README or make derivable. **P3.**

## Verdict

**Lift to findings.md:**
- **P2**: embedding service API key in URL query string. Logs the key in proxy/CDN/server access logs. Move to Authorization header.
- **P2**: first-load failure permanently poisons `loadPromise` — every subsequent `getEmbeddingPipeline` call rejects forever. Needs reset-on-failure.
- **P2**: silent tokenizer truncation on long inputs. Memories > ~400 words get an embedding of their first ~400 words only. Search misses content beyond the cap. Either chunk long inputs or warn on truncation.
- **P2**: no embedding model versioning. Memories keep their old embeddings after a model switch; search mixes incompatible vectors. Schema should track `embedding_model` per row.
