/**
 * "Retrieval / Rerank" settings section — the user-facing half of
 * `src-tauri/src/db/search/rerank.rs`.
 *
 * ## The invariant this UI has to respect
 *
 * Reranking is optional at every tier. Tier 1 (lexical) is pure Rust and always
 * available; Tiers 2 and 3 return "no opinion" whenever the model is missing or
 * the call times out, and Rust silently uses Tier 1. So nothing here may present
 * a tier as required, and nothing may present a failed tier as a broken search.
 *
 * ## Why every backend call is wrapped
 *
 * `get_rerank_config` / `set_rerank_config` are landing in a parallel change. A
 * build without them must show a plain "not ready yet" line, not a white screen
 * or a raw Tauri error — `RerankBackendUnavailable` in `lib/tauri.ts` is what
 * separates that case from a genuine failure.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  IconSearch, IconCheck, IconChevronRight, IconChevronDown,
  IconDownload, IconWarning, IconSliders,
} from '../icons';
import { sectionTitle } from './settingsStyles';
import { t } from '../../lib/i18n';
import {
  getRerankConfig, setRerankConfig,
  RerankBackendUnavailable,
  DEFAULT_RERANK_CONFIG,
  type RerankConfig, type RerankMode,
} from '../../lib/tauri';
import { CROSS_ENCODER_MODEL } from '../../lib/reranker';
import { isCrossEncoderInstalled, markCrossEncoderInstalled } from '../../lib/rerankSearch';
import type { EmbeddingProgress } from '../../lib/embeddings';

/** The four tiers, in ascending cost order — which is also the order a user
 *  should read them in when deciding. */
const MODES: Array<{ id: RerankMode; labelKey: Parameters<typeof t>[0]; descKey: Parameters<typeof t>[0] }> = [
  { id: 'off', labelKey: 'settings.rerank.mode.off', descKey: 'settings.rerank.mode.offDesc' },
  { id: 'lexical', labelKey: 'settings.rerank.mode.lexical', descKey: 'settings.rerank.mode.lexicalDesc' },
  { id: 'crossEncoder', labelKey: 'settings.rerank.mode.crossEncoder', descKey: 'settings.rerank.mode.crossEncoderDesc' },
  { id: 'llm', labelKey: 'settings.rerank.mode.llm', descKey: 'settings.rerank.mode.llmDesc' },
];

/** Knob bounds. Mirrors the Rust clamps where they exist, and is otherwise a
 *  sanity range — the backend re-clamps regardless, this only stops the UI from
 *  offering a value that would immediately be overridden. */
const KNOBS: Array<{
  key: 'topK' | 'llmMaxCandidates' | 'llmMaxSnippetChars' | 'llmTimeoutMs';
  labelKey: Parameters<typeof t>[0];
  descKey: Parameters<typeof t>[0];
  min: number; max: number; step: number;
  unit?: string;
}> = [
  { key: 'topK', labelKey: 'settings.rerank.topK', descKey: 'settings.rerank.topKDesc', min: 2, max: 200, step: 2 },
  { key: 'llmMaxCandidates', labelKey: 'settings.rerank.llmMaxCandidates', descKey: 'settings.rerank.llmMaxCandidatesDesc', min: 2, max: 50, step: 1 },
  { key: 'llmMaxSnippetChars', labelKey: 'settings.rerank.llmMaxSnippetChars', descKey: 'settings.rerank.llmMaxSnippetCharsDesc', min: 80, max: 2000, step: 40 },
  { key: 'llmTimeoutMs', labelKey: 'settings.rerank.llmTimeoutMs', descKey: 'settings.rerank.llmTimeoutMsDesc', min: 1000, max: 60000, step: 1000, unit: 'ms' },
];

export function RerankSettingsSection() {
  // Seeded with the Rust defaults so the card renders something honest before the
  // first load resolves, rather than zeros or an empty selection.
  const [config, setConfig] = useState<RerankConfig>(DEFAULT_RERANK_CONFIG);
  const [backendReady, setBackendReady] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    getRerankConfig()
      .then(c => { if (alive) { setConfig(c); setBackendReady(true); } })
      .catch(e => {
        if (!alive) return;
        if (e instanceof RerankBackendUnavailable) {
          setBackendReady(false);
        } else {
          setBackendReady(true);
          setError(String(e));
        }
      });
    return () => { alive = false; };
  }, []);

  /**
   * Write a patch through, optimistically.
   *
   * Optimistic because a mode click should feel instant, and rolled back on
   * failure because leaving the UI showing a mode the backend never accepted
   * would misrepresent how search is actually behaving.
   */
  const commit = useCallback(async (patch: Partial<RerankConfig>) => {
    const previous = config;
    const next = { ...config, ...patch };
    setConfig(next);
    setError('');
    try {
      // Send only the patch, and adopt the echoed config: the backend clamps
      // knobs into range instead of only rejecting them, so its answer is
      // authoritative over the optimistic `next`.
      const stored = await setRerankConfig(patch);
      // Fall back to the optimistic value if the command answered with nothing:
      // a null here would blank every control.
      setConfig(stored ?? next);
      setBackendReady(true);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
    } catch (e) {
      setConfig(previous);
      if (e instanceof RerankBackendUnavailable) {
        setBackendReady(false);
      } else {
        setError(String(e));
      }
    }
  }, [config]);

  return (
    <div className="settings-section-card">
      <h2 style={sectionTitle}>
        <IconSearch size={18} /> {t('settings.rerank.title')}
      </h2>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-3)', lineHeight: 1.6 }}>
        {t('settings.rerank.desc')}
      </div>

      {/* Backend-missing notice. Not an error style: nothing is broken, the
          feature simply isn't wired in this build yet. */}
      {backendReady === false && (
        <div
          role="status"
          data-testid="rerank-backend-not-ready"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--warning-bg, rgba(255,180,0,0.12))',
            color: 'var(--warning, #b26a00)',
            fontSize: 'var(--text-xs)',
            lineHeight: 1.5,
            marginBottom: 'var(--space-3)',
          }}
        >
          <IconWarning size={14} />
          <span>{t('settings.rerank.backendNotReady')}</span>
        </div>
      )}

      {/* Mode picker */}
      <div role="radiogroup" aria-label={t('settings.rerank.modeLabel')} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {MODES.map(m => {
          const active = config.mode === m.id;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`rerank-mode-${m.id}`}
              onClick={() => commit({ mode: m.id })}
              style={{
                textAlign: 'left',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--space-3)',
                padding: 'var(--space-3)',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${active ? 'var(--accent, #3b82f6)' : 'var(--border)'}`,
                background: active ? 'color-mix(in srgb, var(--accent, #3b82f6) 8%, transparent)' : 'var(--bg-primary)',
                cursor: 'pointer',
              }}
            >
              <span style={{ width: 16, flexShrink: 0, display: 'inline-flex', paddingTop: 2, color: 'var(--accent, #3b82f6)' }}>
                {active && <IconCheck size={14} />}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>{t(m.labelKey)}</span>
                <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>
                  {t(m.descKey)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {savedFlash && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success, #22c55e)', marginTop: 'var(--space-2)' }}>
          {t('settings.rerank.saved')}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: 'var(--space-2)' }}>{error}</div>
      )}

      {/* Tier 2 needs a model; only offer the download when Tier 2 is chosen. */}
      {config.mode === 'crossEncoder' && <CrossEncoderModelCard />}

      {/* Tier 3 cost guards, folded away — most users never touch these. */}
      <div style={{ marginTop: 'var(--space-4)' }}>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => setAdvancedOpen(v => !v)}
          aria-expanded={advancedOpen}
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}
        >
          {advancedOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <IconSliders size={14} />
          {t('settings.rerank.advanced')}
        </button>

        {advancedOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
            {KNOBS.map(k => (
              <KnobRow
                key={k.key}
                label={t(k.labelKey)}
                description={t(k.descKey)}
                value={config[k.key]}
                min={k.min}
                max={k.max}
                step={k.step}
                unit={k.unit}
                testId={`rerank-knob-${k.key}`}
                onCommit={v => commit({ [k.key]: v } as Partial<RerankConfig>)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * One numeric knob. Local draft state with commit-on-blur/Enter rather than
 * commit-on-keystroke: every commit is a Tauri round-trip plus a SQLite write,
 * and typing "320" would otherwise fire three of them (and briefly persist "3").
 */
function KnobRow({
  label, description, value, min, max, step, unit, testId, onCommit,
}: {
  label: string;
  description: string;
  value: number;
  min: number; max: number; step: number;
  unit?: string;
  testId: string;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Re-sync when the value changes underneath us — notably after an optimistic
  // update is rolled back.
  useEffect(() => { setDraft(String(value)); }, [value]);

  const flush = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.round(Math.max(min, Math.min(max, parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 'var(--space-4)',
      padding: 'var(--space-3)',
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <label htmlFor={testId} style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600 }}>{label}</label>
        <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2, lineHeight: 1.5 }}>
          {description}
        </span>
        <span style={{ display: 'block', fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--font-mono, monospace)', marginTop: 4 }}>
          {min} – {max}{unit ? ` ${unit}` : ''}
        </span>
      </div>
      <input
        id={testId}
        data-testid={testId}
        className="input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={flush}
        onKeyDown={e => { if (e.key === 'Enter') { flush(); e.currentTarget.blur(); } }}
        style={{ width: 110, flexShrink: 0, textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}
      />
    </div>
  );
}

// ── Tier 2 model download ───────────────────────────────────────────
//
// `lib/reranker.ts` owns the scoring worker but does not surface download
// progress (its `onmessage` only handles `scores-ok` / `error`). Rather than
// change that read-only module, this card drives its own short-lived worker for
// the one-off warm-up, listening for the `progress` messages
// `reranker.worker.ts` already posts. Payload is field-for-field
// `EmbeddingProgress`, so the same progress-bar shape as `EmbeddingSettings`
// applies.

type DownloadState = 'idle' | 'running' | 'ready' | 'failed';

function CrossEncoderModelCard() {
  // Seeded from the persisted consent flag: if the user downloaded the model on a
  // previous run, Tier 2 can genuinely run now, and the card must say so — this
  // flag is the exact gate `searchChunksReranked` uses, so showing anything else
  // here would misreport whether Tier 2 is live.
  const [state, setState] = useState<DownloadState>(() =>
    isCrossEncoderInstalled() ? 'ready' : 'idle',
  );
  const [progress, setProgress] = useState<EmbeddingProgress | null>(null);

  const handleDownload = () => {
    setState('running');
    setProgress(null);

    // Created on click, never at module scope: a user who never opens this card
    // must not pay for a worker, and jsdom has no Worker implementation.
    const worker = new Worker(new URL('../../lib/reranker.worker.ts', import.meta.url), { type: 'module' });

    const finish = (next: DownloadState) => {
      setState(next);
      setProgress(null);
      worker.terminate();
    };

    worker.onmessage = (e: MessageEvent) => {
      const { type, payload } = e.data ?? {};
      if (type === 'progress') {
        setProgress(payload as EmbeddingProgress);
      } else if (type === 'scores-ok') {
        // The pipeline built and ran, which is the only proof that the model is
        // genuinely usable and not just partially cached. That forward pass is
        // also the user's explicit consent to the download, so record it: it is
        // what unlocks Tier 2 at query time. Without this the search path would
        // never dare touch the model (a remote fetch is one `pipeline()` call
        // away) and `crossEncoder` would keep silently meaning "lexical".
        markCrossEncoderInstalled();
        finish('ready');
      } else if (type === 'error') {
        console.warn('[rerank] cross-encoder warm-up failed:', payload?.error);
        finish('failed');
      }
    };
    worker.onerror = () => finish('failed');

    // A trivial pair: the point is to force the model download and one forward
    // pass, not to rank anything.
    worker.postMessage({
      type: 'score',
      payload: { id: 1, query: 'warm up', pairs: ['warm up'], model: CROSS_ENCODER_MODEL },
    });
  };

  const percent = progress ? Math.max(0, Math.min(100, Math.round(progress.progress))) : 0;

  return (
    <div style={{
      marginTop: 'var(--space-3)',
      padding: 'var(--space-3)',
      background: 'var(--bg-primary)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--space-2)',
    }}>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>
        {t('settings.rerank.model.title')}
      </div>

      {/* Size / language / licence, stated up front — 288 MB is not a surprise
          a user should discover from their network meter. */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontFamily: 'var(--font-mono, monospace)', lineHeight: 1.5 }}>
        {t('settings.rerank.model.facts')}
      </div>

      {/* The reassurance that makes skipping the download a real option. */}
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
        {t('settings.rerank.model.fallback')}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        <button
          type="button"
          className={`btn btn-sm ${state === 'ready' ? 'btn-success' : 'btn-primary'}`}
          onClick={handleDownload}
          disabled={state === 'running'}
          data-testid="rerank-model-download"
        >
          {state === 'running'
            ? (<><span className="spinner" style={{ width: 14, height: 14 }} /> {t('settings.rerank.model.downloading')}</>)
            : (<><IconDownload size={14} /> {t('settings.rerank.model.download')}</>)}
        </button>
        {state === 'ready' && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--success, #22c55e)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconCheck size={14} /> {t('settings.rerank.model.ready')}
          </span>
        )}
        {state === 'failed' && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--warning, #d97706)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <IconWarning size={14} /> {t('settings.rerank.model.failed')}
          </span>
        )}
      </div>

      {/* Same bar shape as the embedding index progress in EmbeddingSettings. */}
      {state === 'running' && progress && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress.file}</span>
            <span>{percent}%</span>
          </div>
          <div style={{ height: 6, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{
              width: `${percent}%`,
              height: '100%',
              background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary, var(--accent-primary)))',
              borderRadius: 3,
              transition: 'width 0.3s ease',
            }} />
          </div>
        </>
      )}
    </div>
  );
}
