/**
 * The embedding index build, shared by the Dashboard and Settings.
 *
 * It used to be two copies of one loop that aborted the whole build on the first
 * error. Pending chunks always come back in the same order, so a single chunk an
 * API rejects (too long, filtered, malformed) failed every later build at the
 * same spot and the index could never complete. Now:
 *
 * - A failed batch is split in half and retried, down to the single chunk that
 *   fails; only that chunk is recorded (`recordEmbeddingFailures`). The backend
 *   then skips it for a growing delay, and for good after repeated failures, so
 *   the rest of the index completes.
 * - Errors that are about the setup rather than a chunk (rejected credentials,
 *   missing config, endpoint unreachable, local model not loading) still stop
 *   the build at once: splitting would only repeat them.
 * - A circuit breaker stops the build after several chunks fail in a row with
 *   nothing succeeding in between, so a broken endpoint is not walked chunk by
 *   chunk through the whole vault.
 * - `.zettelignore` rules are re-applied first (`prepareEmbeddingBuild`).
 */
import {
  syncEmbeddingModel,
  prepareEmbeddingBuild,
  getUnindexedChunks,
  saveChunkEmbeddings,
  recordEmbeddingFailures,
  finalizeEmbeddingIndex,
  fetchCustomEmbeddings,
  EmbeddingIgnoreSummary,
} from './tauri';
import { getEmbeddingsBatch } from './embeddings';
import { EMBEDDING_DIM } from './embeddingModel';

export interface EmbedConfig {
  mode?: string;
  apiUrl?: string;
  model?: string;
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

export type BuildStage =
  | { kind: 'reading' }
  | { kind: 'embedding'; count: number; remote: boolean }
  | { kind: 'saving' }
  | { kind: 'finalizing' };

export interface BuildReport {
  /** Chunks embedded and saved in this build. */
  embedded: number;
  /** Chunks that failed in this build and will be retried by a later one. */
  failed: number;
  /** Of those, chunks now skipped until a manual retry. */
  skipped: number;
  ignore: EmbeddingIgnoreSummary;
  cancelled: boolean;
  /** Last per-chunk error, for display. */
  lastError?: string;
}

/** Chunks requested per round trip. */
export const BATCH_SIZE = 16;
/** Consecutive single-chunk failures with no success in between that stop the build. */
export const CIRCUIT_BREAKER = 8;

/** Error that will recur for every chunk: stop instead of splitting. */
export class EmbeddingSetupError extends Error {}

/**
 * Is this error about the setup (credentials, config, reachability, the local
 * model) rather than about the chunk? Matches the messages Rust and the worker
 * actually produce, in both UI languages.
 */
export function isSetupError(message: string): boolean {
  return /\b40[13]\b|unauthori[sz]ed|forbidden|invalid.?api.?key|API Key|凭据|未配置|not configured|配置不完整|不能为空|cannot be empty|connection refused|ECONNREFUSED|actively refused|无法连接|\bdns\b|getaddrinfo|no such host|initiali[sz]e embedding worker|model loading|All embedding backends failed/i.test(
    message,
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The embedder the saved config calls for. */
export function embedderFor(config: EmbedConfig): Embedder {
  if (config.mode === 'custom') {
    return async (texts) => {
      if (!config.apiUrl || !config.model) {
        throw new EmbeddingSetupError('Embedding API 配置不完整 / Incomplete Embedding API configuration');
      }
      return fetchCustomEmbeddings(config.apiUrl, config.model, texts);
    };
  }
  return (texts) => getEmbeddingsBatch(texts, 'document');
}

export async function runEmbeddingBuild(opts: {
  config: EmbedConfig;
  isCancelled: () => boolean;
  onStage?: (stage: BuildStage) => void;
  /** After each saved batch (e.g. to refresh progress). */
  onProgress?: () => void | Promise<void>;
  /** Injected in tests; defaults to `embedderFor(config)`. */
  embed?: Embedder;
}): Promise<BuildReport> {
  const { config, isCancelled, onStage, onProgress } = opts;
  const embed = opts.embed ?? embedderFor(config);
  const remote = config.mode === 'custom';

  // Never mix vectors from two models: a changed config clears them first.
  await syncEmbeddingModel(config);
  const ignore = await prepareEmbeddingBuild();

  const report: BuildReport = { embedded: 0, failed: 0, skipped: 0, ignore, cancelled: false };
  let failuresInARow = 0;

  /** Embed and save `chunks`; on failure split until the failing chunks are isolated. */
  const process = async (chunks: [number, string][]): Promise<void> => {
    if (isCancelled()) return;
    let vectors: number[][];
    try {
      onStage?.({ kind: 'embedding', count: chunks.length, remote });
      vectors = await embed(chunks.map(([, text]) => text));
      const wrongDim = vectors.find((v) => v && v.length !== EMBEDDING_DIM);
      if (wrongDim) {
        // Every chunk would fail the same way: the model does not fit the index.
        throw new EmbeddingSetupError(
          `向量维度 ${wrongDim.length} 与索引的 ${EMBEDDING_DIM} 不一致，请换用 ${EMBEDDING_DIM} 维的模型 / ` +
            `the model returns ${wrongDim.length}-dimensional vectors, the index needs ${EMBEDDING_DIM}`,
        );
      }
      if (vectors.length !== chunks.length || vectors.some((v) => !v)) {
        throw new Error(`embedding returned ${vectors.length} vector(s) for ${chunks.length} input(s)`);
      }
    } catch (e) {
      const message = messageOf(e);
      if (e instanceof EmbeddingSetupError || isSetupError(message)) {
        throw e instanceof EmbeddingSetupError ? e : new EmbeddingSetupError(message);
      }
      if (chunks.length > 1) {
        const mid = Math.ceil(chunks.length / 2);
        await process(chunks.slice(0, mid));
        await process(chunks.slice(mid));
        return;
      }
      const [outcome] = await recordEmbeddingFailures([chunks[0][0]], message);
      report.failed += 1;
      if (outcome?.permanent) report.skipped += 1;
      report.lastError = message;
      failuresInARow += 1;
      if (failuresInARow >= CIRCUIT_BREAKER) {
        throw new EmbeddingSetupError(message);
      }
      return;
    }
    if (isCancelled()) return;
    onStage?.({ kind: 'saving' });
    await saveChunkEmbeddings(chunks.map(([id], i) => [id, vectors[i]]));
    report.embedded += chunks.length;
    failuresInARow = 0;
    await onProgress?.();
  };

  for (;;) {
    if (isCancelled()) {
      report.cancelled = true;
      return report;
    }
    onStage?.({ kind: 'reading' });
    const chunks = await getUnindexedChunks(BATCH_SIZE);
    if (chunks.length === 0) break;
    await process(chunks);
    // Let the UI paint between batches.
    await new Promise<void>((r) => setTimeout(r, 0));
  }

  onStage?.({ kind: 'finalizing' });
  await finalizeEmbeddingIndex();
  return report;
}

/** Progress line for a build stage. */
export function buildStageText(s: BuildStage, zh: boolean): string {
  switch (s.kind) {
    case 'reading':
      return zh ? '正在读取未索引的笔记分块...' : 'Reading unindexed note chunks...';
    case 'embedding':
      if (s.remote) {
        return zh
          ? `正在通过 API 请求计算向量 (本组分块: ${s.count})...`
          : `Requesting vectors via API (batch chunks: ${s.count})...`;
      }
      return zh
        ? `正在通过本地线程计算向量 (本组分块: ${s.count})...`
        : `Computing vectors in background thread (batch chunks: ${s.count})...`;
    case 'saving':
      return zh ? '正在将生成的向量存入本地数据库...' : 'Saving generated vectors to local database...';
    case 'finalizing':
      return zh ? '正在重建语义图关系与索引缓存...' : 'Rebuilding semantic graph relationships and index cache...';
  }
}

/** One-line bilingual summary of a finished build. */
export function describeBuild(r: BuildReport, zh: boolean): string {
  const parts: string[] = [zh ? `已索引 ${r.embedded} 个分块` : `Indexed ${r.embedded} chunks`];
  if (r.failed > 0) {
    const later = r.failed - r.skipped;
    if (later > 0) parts.push(zh ? `${later} 个失败，稍后构建会自动重试` : `${later} failed and will be retried by a later build`);
    if (r.skipped > 0) parts.push(zh ? `${r.skipped} 个多次失败，已跳过` : `${r.skipped} skipped after repeated failures`);
  }
  if (r.ignore.ignoredChunks > 0) {
    parts.push(
      zh
        ? `${r.ignore.ignoredFiles} 篇笔记按 .zettelignore 忽略`
        : `${r.ignore.ignoredFiles} notes ignored by .zettelignore`,
    );
  }
  return parts.join(zh ? '；' : '; ');
}
