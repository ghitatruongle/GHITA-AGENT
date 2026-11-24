# Memory & RAG v1.1.0 — Track 6: ingestion, retrieval, capture, contradiction, provenance

Tài liệu cho `packages/ingest` (mới) và `packages/memory/src/track6` (mục tiêu 42–46).

## 1. Ingest pipeline (`packages/ingest`) — P65/P66/P67/P68/P73

### Loaders (`src/loaders.ts`)

- `loadDocument(path, { readPdf })` — md/json/csv/txt + **docx** (trích `<w:t>` từ zip
  byte, không cần native dep) + **pdf** qua `PdfReader` injectable.
- `loadDirectory(dir)` — discover (bỏ .git/node_modules/dist) + load, path chuẩn hoá
  cross-platform; `discoverFiles(dir, extensions)`.
- `redactSecrets(content)` — guardrail P73: strip sk-/AKIA/ghp\_/Bearer trước khi index.

### Splitters (`src/splitters.ts`)

- `splitFixed` (size + overlap) · `splitMarkdown` (heading context, kể cả heading-only) ·
  `splitCode` (line windows) · `splitRecursive` (paragraph → fixed).
- `chunkDocument(doc, opts, meta)` — route theo source type → `Chunk[]` (id ổn định,
  tokenEstimate).

### Indexer (`src/indexer.ts`)

- `IngestIndexer(sink, { redact, knownHashes, onProgress, signal, readPdf })` —
  incremental: bỏ qua file hash không đổi; **dedup theo content hash**; progress +
  abort; `index(target)` → `IndexStats {docs, chunks, deduplicated, skipped, durationMs}`.
- Sink injectable → nối vào `@ghita/memory` KnowledgeEngine khi tích hợp.

### Engine sink: ingest → memory (`src/engine-sink.ts`) — P67

- `createKnowledgeEngineSink(engine, { chunkSize, chunkOverlap, generateEmbeddings,
typeFor })` — `ChunkSink` upsert từng document vào `KnowledgeEngine.ingestDocument`
  (hash-dedup nằm sẵn trong engine → **incremental upsert**); metadata kèm
  `sourceType/bytes/ingestChunks/hash`; `KnowledgeEngineLike` structural (không phụ
  thuộc memory internals).
- E2E verify: `engine-sink.test.ts` — index dir thật → `engine.getStats()` docs/chunks
  > 0; re-index cùng indexer → `deduplicated=2`, engine vẫn 2 docs.

### Skill `document.ingest` (`packages/skills/src/ingest/document-ingest.ts`) — P68

- `createDocumentIngestSkill({ sink?, redact?, chunkSize?, overlap?, knownHashes? })` —
  SkillDefinition id `document.ingest`: input `{ path }` → chạy IngestIndexer (sink mặc
  định no-op, hoặc sink KnowledgeEngine khi wire) → trả stats cho agent báo cáo.
- Verify: `document-ingest.test.ts` — registry run trên dir thật (success + "2
  document(s)"), lỗi sạch khi thiếu path, upsert vào engine sink, dedup re-index.

### CLI (`src/cli.ts`) — `ghita-ingest <path> [--redact] [--chunk-size] [--overlap]`

- Viết `chunks.json` + `stats.json` vào `--out` (mặc định `.ghita/ingest`).

### Retrieval (`src/retrieval.ts`) — P69

- `bm25Score(query, chunks)` — scorer nhẹ (k1/b), `reciprocalRankFusion(lists, k)` —
  RRF k=60.
- `HybridRetriever(chunks, vectors, { vectorThreshold })` — `retrieve()` (BM25 + vector
  fused RRF) và `retrieveMMR()` (diversity λ=0.7).
- `parentDocumentRetrieval(children, parentOf, query)` — trả parent chunk.

## 2. Memory auto-capture (`packages/memory/src/track6/hooks.ts`) — P70

- `MemoryCaptureHooks(sink, { windowMs = 300_000 })` — 6 điểm bắt:
  `sessionStart` / `userPrompt` / `preTool` / `postTool` (+`post-tool-failure`) /
  `preCompact`; **dedup 5 phút** theo content-hash (khác session vẫn ghi);
  `stats().emitted`.

## 3. Contradiction & supersede (`track6/contradiction.ts`) — P71

- `ContradictionDetector({ similarityThreshold, polarityPairs })` — cùng chủ đề
  (embedder injectable / lexical fallback ≥0.4 overlap) + cặp polarity
  (true/false, works/broken, windows/macos…) → `{conflicting, action:
supersede|revise|keep, confidence, reason}`; entry mới hơn → `supersede`.
- `SupersedeTracker` — chuỗi supersede + `origin()` truy ngược bản gốc.
- `cosine(a, b)`.

## 4. Provenance & rollback (`track6/provenance.ts`) — P72

- `ProvenanceStore.record({memoryId, agentId, namespace: public|private, source,
content})` — lưu `snapshotHash` (SHA-256), `prevVersionId`, `at`; `history(id)`,
  `latest(id)`, `rollback(id)` (git-style), `listByNamespace(namespace, agentId?)`,
  `verify(id, content)`.

## Exports

```ts
// @ghita/ingest
import {
  IngestIndexer,
  loadDocument,
  loadDirectory,
  chunkDocument,
  splitMarkdown,
  HybridRetriever,
  redactSecrets,
  bm25Score,
} from '@ghita/ingest';
// @ghita/memory
import {
  MemoryCaptureHooks,
  ContradictionDetector,
  SupersedeTracker,
  ProvenanceStore,
} from '@ghita/memory';
```

## Verify

```bash
pnpm --filter @ghita/ingest typecheck && pnpm --filter @ghita/ingest test   # 18 tests
pnpm --filter @ghita/memory typecheck && pnpm --filter @ghita/memory test  # 215 tests
node packages/ingest/dist/cli.js <path>                                    # smoke
```
