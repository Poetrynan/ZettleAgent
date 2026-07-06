import { useState, useEffect, useCallback, useRef } from 'react';
import { IconChevronRight, IconDatabase, IconBrain, IconPlug, IconSync, IconWarning } from '../icons';
import { sectionTitle, rowBetween, rowLabel } from './settingsStyles';
import {
  getUnindexedChunks,
  saveChunkEmbeddings,
  finalizeEmbeddingIndex,
  getEmbeddingStats,
} from '../../lib/tauri';
import { getEmbeddingsBatch } from '../../lib/embeddings';
import { ask } from '@tauri-apps/plugin-dialog';
import { detectHardware, recommendConfig, getGpuSummary, type HardwareProfile, type RecommendedConfig } from '../../lib/hardwareDetect';

type EmbeddingMode = 'local' | 'custom';

interface EmbeddingConfig {
  mode: EmbeddingMode;
  apiUrl: string;
  model: string;
  dimensions: number;
}

const STORAGE_KEY = 'zettelagent:embedding_config';

function loadConfig(): EmbeddingConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { mode: 'local', apiUrl: '', model: '', dimensions: 1536 };
}

function saveConfig(cfg: EmbeddingConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

export function getEmbeddingConfig(): EmbeddingConfig {
  return loadConfig();
}

export function EmbeddingConfigSection({ isZh, apiKey }: { isZh: boolean; apiKey?: string }) {
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<string | null>(null);
  const [stats, setStats] = useState<{ total_chunks: number; indexed_chunks: number; has_index: boolean } | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [buildStage, setBuildStage] = useState<string>('');
  const cancelRef = useRef<boolean>(false);

  // Embedding mode & custom config
  const [mode, setMode] = useState<EmbeddingMode>('local');
  const [customApiUrl, setCustomApiUrl] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [customDimensions, setCustomDimensions] = useState(1536);
  const [configSaved, setConfigSaved] = useState(false);

  // Hardware detection state
  const [hwProfile, setHwProfile] = useState<HardwareProfile | null>(null);
  const [hwRecommend, setHwRecommend] = useState<RecommendedConfig | null>(null);
  const [hwDetecting, setHwDetecting] = useState(false);

  // Load persisted config on mount
  useEffect(() => {
    const cfg = loadConfig();
    setMode(cfg.mode);
    setCustomApiUrl(cfg.apiUrl);
    setCustomModel(cfg.model);
    setCustomDimensions(cfg.dimensions);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    getEmbeddingStats()
      .then(setStats)
      .catch(e => console.error('Failed to get embedding stats:', e));
  }, [expanded]);

  // Auto-detect hardware on mount
  useEffect(() => {
    setHwDetecting(true);
    detectHardware()
      .then(profile => {
        setHwProfile(profile);
        setHwRecommend(recommendConfig(profile));
      })
      .catch(e => console.warn('Hardware detection failed:', e))
      .finally(() => setHwDetecting(false));
  }, []);

  const handleBuildIndex = async () => {
    if (stats && stats.total_chunks > 0 && stats.indexed_chunks === stats.total_chunks) {
      const confirmRebuild = await ask(
        isZh
          ? '当前所有笔记均已建立向量索引（进度已达 100%），重新构建可能需要一些时间。是否确定继续重新构建？'
          : 'All notes are already indexed (100%). Rebuilding may take some time. Are you sure you want to continue?',
        {
          title: isZh ? '重新构建索引' : 'Rebuild Index',
          kind: 'warning',
          okLabel: isZh ? '确定' : 'OK',
          cancelLabel: isZh ? '取消' : 'Cancel'
        }
      );
      if (!confirmRebuild) return;
    }

    setBuilding(true);
    setBuildResult(null);
    setBuildStage(isZh ? '正在初始化向量模块...' : 'Initializing embedding module...');
    cancelRef.current = false;

    try {
      let totalProcessed = 0;
      let hasMore = true;
      const batchSize = 16;

      while (hasMore) {
        if (cancelRef.current) {
          setBuildResult(isZh ? '构建任务已被用户中止' : 'Build task was cancelled by user');
          break;
        }

        // 1. 获取未索引的分块
        setBuildStage(isZh ? '正在读取未索引的笔记分块...' : 'Reading unindexed note chunks...');
        const chunks = await getUnindexedChunks(batchSize);
        if (chunks.length === 0) {
          hasMore = false;
          break;
        }

        // 2. 生成嵌入向量
        const contents = chunks.map(([_, content]) => content);
        let embeddings: number[][];

        if (mode === 'local') {
          setBuildStage(isZh 
            ? `正在通过本地线程计算向量 (本组分块: ${contents.length})...`
            : `Computing vectors in background thread (batch chunks: ${contents.length})...`
          );
          embeddings = await getEmbeddingsBatch(contents, 'document');
        } else {
          setBuildStage(isZh 
            ? `正在通过 API 请求计算向量 (本组分块: ${contents.length})...`
            : `Requesting vectors via API (batch chunks: ${contents.length})...`
          );
          // 自定义 API 模式
          const effectiveApiKey = apiKey || '';
          if (!customApiUrl) {
            throw new Error(isZh ? 'API Endpoint 不能为空' : 'API Endpoint cannot be empty');
          }
          if (!customModel) {
            throw new Error(isZh ? '模型名称不能为空' : 'Model name cannot be empty');
          }
          // 发起 API 请求
          const response = await fetch(customApiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${effectiveApiKey}`,
            },
            body: JSON.stringify({
              input: contents,
              model: customModel,
            }),
          });
          if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error (${response.status}): ${errText}`);
          }
          const data = await response.json();
          if (!data.data || !Array.isArray(data.data)) {
            throw new Error(isZh ? 'API 返回格式不正确' : 'Invalid API response format');
          }
          const sorted = data.data.sort((a: any, b: any) => a.index - b.index);
          embeddings = sorted.map((item: any) => item.embedding);
        }

        if (cancelRef.current) {
          setBuildResult(isZh ? '构建任务已被用户中止' : 'Build task was cancelled by user');
          break;
        }

        // 3. 保存到 Rust SQLite
        setBuildStage(isZh ? '正在将生成的向量存入本地数据库...' : 'Saving generated vectors to local database...');
        const payload: [number, number[]][] = chunks.map(([id, _], index) => [id, embeddings[index]]);
        await saveChunkEmbeddings(payload);

        totalProcessed += chunks.length;

        // 实时更新进度条
        const currentStats = await getEmbeddingStats();
        setStats(currentStats);

        // 让出主线程事件循环，防止浏览器卡死
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      if (!cancelRef.current) {
        // 4. 重建边和索引缓存
        setBuildStage(isZh ? '正在重建语义图关系与索引缓存...' : 'Rebuilding semantic graph relationships and index cache...');
        await finalizeEmbeddingIndex();

        setBuildResult(isZh
          ? `已成功索引 ${totalProcessed} 个分块`
          : `Successfully indexed ${totalProcessed} chunks`
        );
      }

      const finalStats = await getEmbeddingStats();
      setStats(finalStats);
    } catch (e: any) {
      setBuildResult(isZh ? `构建失败: ${e.message || e}` : `Build failed: ${e.message || e}`);
    }
    setBuilding(false);
  };

  const handleModeChange = useCallback((newMode: EmbeddingMode) => {
    setMode(newMode);
    saveConfig({ mode: newMode, apiUrl: customApiUrl, model: customModel, dimensions: customDimensions });
  }, [customApiUrl, customModel, customDimensions]);

  const handleSaveCustomConfig = useCallback(() => {
    saveConfig({ mode, apiUrl: customApiUrl, model: customModel, dimensions: customDimensions });
    setConfigSaved(true);
    setTimeout(() => setConfigSaved(false), 2000);
  }, [mode, customApiUrl, customModel, customDimensions]);

  const progressPercent = stats ? (stats.total_chunks > 0 ? Math.round((stats.indexed_chunks / stats.total_chunks) * 100) : 0) : 0;

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '8px 12px',
    border: 'none',
    borderRadius: 'calc(var(--radius-md) - 2px)',
    background: active ? 'var(--bg-primary)' : 'transparent',
    color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
    fontWeight: active ? 600 : 400,
    fontSize: 'var(--text-sm)',
    cursor: 'pointer',
    transition: 'all 0.2s',
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
  });

  return (
    <div className="settings-section-card">
      <h2
        style={{ ...sectionTitle, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ display: 'inline-block', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
          <IconChevronRight size={18} />
        </span>
        <IconDatabase size={18} /> {isZh ? '嵌入向量引擎' : 'Embedding Engine'}
      </h2>

      {expanded && (
        <>
          {/* Hardware Auto-Detection Card */}
          <div style={{
            padding: 'var(--space-4)',
            background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-primary) 4%, transparent), color-mix(in srgb, var(--accent-secondary) 4%, transparent))',
            border: '1px solid color-mix(in srgb, var(--accent-primary) 15%, transparent)',
            borderRadius: 'var(--radius-lg)',
            marginBottom: 'var(--space-4)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 'var(--radius-md)',
                  background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                  color: 'var(--accent-primary)', flexShrink: 0,
                }}>
                  <IconBrain size={16} />
                </span>
                <div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {isZh ? '硬件自动检测' : 'Hardware Auto-Detection'}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    {isZh ? '自动检测 GPU 并推荐最优配置' : 'Auto-detect GPU and recommend optimal settings'}
                  </div>
                </div>
              </div>
              {hwDetecting && (
                <span className="spinner" style={{
                  width: 14, height: 14,
                  border: '2px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)',
                  borderTopColor: 'var(--accent-primary)',
                  borderRadius: '50%',
                  animation: 'dash-spin 0.8s linear infinite',
                  display: 'inline-block', flexShrink: 0,
                }} />
              )}
            </div>

            {/* GPU Info */}
            {hwProfile && (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
                padding: 'var(--space-3)',
                background: 'var(--bg-primary)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle, rgba(128,128,128,0.1))',
              }}>
                {/* GPU name + WebGPU badge */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', overflow: 'hidden', minWidth: 0 }}>
                    <IconDatabase size={12} style={{ flexShrink: 0 }} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {hwProfile.bestGpu?.name || (isZh ? '未检测到 GPU' : 'No GPU detected')}
                    </span>
                  </div>
                  {/* WebGPU compatibility badge */}
                  {hwProfile.bestGpu && (
                    <span style={{
                      fontSize: '10px', fontWeight: 600, flexShrink: 0,
                      padding: '2px 8px', borderRadius: 'var(--radius-full)',
                      background: hwProfile.bestGpu.is_webgpu_compatible
                        ? 'color-mix(in srgb, var(--success, #22c55e) 12%, transparent)'
                        : 'color-mix(in srgb, var(--warning, #F59E0B) 12%, transparent)',
                      color: hwProfile.bestGpu.is_webgpu_compatible
                        ? 'var(--success, #22c55e)'
                        : 'var(--warning, #F59E0B)',
                      border: `1px solid ${hwProfile.bestGpu.is_webgpu_compatible
                        ? 'color-mix(in srgb, var(--success, #22c55e) 25%, transparent)'
                        : 'color-mix(in srgb, var(--warning, #F59E0B) 25%, transparent)'}`,
                    }}>
                      {hwProfile.bestGpu.is_webgpu_compatible
                        ? (isZh ? '✓ WebGPU' : '✓ WebGPU')
                        : (isZh ? '✗ 不兼容' : '✗ Incompatible')}
                    </span>
                  )}
                </div>
                {/* GPU details row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
                  <span>{getGpuSummary(hwProfile, isZh)}</span>
                  {hwProfile.deviceMemoryGB > 0 && (
                    <span>· {isZh ? '内存' : 'RAM'}: ~{hwProfile.deviceMemoryGB} {isZh ? 'GB' : 'GB'}</span>
                  )}
                  {hwProfile.cpuCores > 0 && (
                    <span>· {hwProfile.cpuCores} {isZh ? '核' : 'cores'}</span>
                  )}
                </div>
              </div>
            )}

            {/* Recommendation */}
            {hwRecommend && (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginTop: 'var(--space-3)',
                padding: 'var(--space-3)',
                background: hwRecommend.precise
                  ? 'color-mix(in srgb, var(--success, #22c55e) 8%, transparent)'
                  : 'color-mix(in srgb, var(--warning, #F59E0B) 8%, transparent)',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${hwRecommend.precise
                  ? 'color-mix(in srgb, var(--success, #22c55e) 20%, transparent)'
                  : 'color-mix(in srgb, var(--warning, #F59E0B) 20%, transparent)'}`,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>
                    {isZh ? '推荐配置' : 'Recommended'}: {hwRecommend.backend.toUpperCase()} · batch {hwRecommend.batchSize}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', lineHeight: 1.4 }}>
                    {hwRecommend.reason[isZh ? 'zh' : 'en']}
                  </div>
                </div>
                <button
                  className="btn btn-sm"
                  style={{
                    fontSize: 'var(--text-xs)', fontWeight: 600,
                    padding: '4px 12px', flexShrink: 0, marginLeft: 'var(--space-3)',
                    background: 'var(--accent-primary)', color: '#fff', border: 'none',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                  }}
                  onClick={() => {
                    // Apply recommendation: switch to local mode with recommended backend
                    handleModeChange('local');
                    // Store recommended batch size for build process
                    localStorage.setItem('zettelagent:embedding_batch_size', String(hwRecommend.batchSize));
                  }}
                >
                  {isZh ? '应用' : 'Apply'}
                </button>
              </div>
            )}
          </div>

          {/* Mode selector - pill toggle */}
          <div style={{
            display: 'flex',
            gap: 'var(--space-2)',
            padding: '2px',
            background: 'var(--bg-tertiary)',
            borderRadius: 'var(--radius-md)',
          }}>
            <button style={tabStyle(mode === 'local')} onClick={() => handleModeChange('local')}>
              <IconBrain size={14} /> {isZh ? '内置模型（推荐）' : 'Built-in Model (Recommended)'}
            </button>
            <button style={tabStyle(mode === 'custom')} onClick={() => handleModeChange('custom')}>
              <IconPlug size={14} /> {isZh ? '自定义 API' : 'Custom API'}
            </button>
          </div>

          {/* Local model info banner */}
          {mode === 'local' && (
            <div style={{
              padding: 'var(--space-3)',
              background: 'linear-gradient(135deg, rgba(34,197,94,0.08), rgba(59,130,246,0.08))',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 'var(--radius-md)', background: 'rgba(34,197,94,0.12)', color: 'var(--success, #22c55e)', flexShrink: 0 }}><IconBrain size={16} /></span>
                <div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    nomic-ai/nomic-embed-text-v1.5 (q8)
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    {isZh
                      ? '768 维 · 8192 Token 窗口 · WebAssembly/WebGPU 离线推理'
                      : '768-dim · 8192 token window · WebAssembly/WebGPU offline inference'}
                  </div>
                </div>
              </div>
              <div style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--success, #22c55e)',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--success, #22c55e)', display: 'inline-block' }} />
                {isZh ? '前端 Wasm/WebGPU 引擎就绪 · 模型将缓存于浏览器' : 'Frontend WASM/WebGPU engine ready · Model will be cached in browser'}
              </div>
            </div>
          )}

          {/* Custom API config form */}
          {mode === 'custom' && (
            <div style={{
              padding: 'var(--space-4)',
              background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(168,85,247,0.06))',
              border: '1px solid rgba(99,102,241,0.15)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}>
              {/* Header with icon */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 28, height: 28, borderRadius: 'var(--radius-md)',
                  background: 'rgba(99,102,241,0.12)', color: '#6366f1', flexShrink: 0,
                }}><IconPlug size={14} /></span>
                <div>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {isZh ? '外部 Embedding API' : 'External Embedding API'}
                  </div>
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    {isZh
                      ? '需联网调用，复用模型配置中的 API Key'
                      : 'Requires network. Reuses the API Key from model settings.'}
                  </div>
                </div>
              </div>

              {/* API Endpoint */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.02em' }}>
                  API Endpoint
                </label>
                <input
                  className="settings-input"
                  value={customApiUrl}
                  onChange={e => setCustomApiUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1/embeddings"
                  style={{
                    fontSize: 'var(--text-sm)',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 12px',
                    transition: 'border-color 0.2s, box-shadow 0.2s',
                  }}
                />
              </div>

              {/* Model + Dimensions row */}
              <div style={{ display: 'flex', gap: 'var(--space-3)' }}>
                <div style={{ flex: 2, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.02em' }}>
                    {isZh ? '模型名称' : 'Model Name'}
                  </label>
                  <input
                    className="settings-input"
                    value={customModel}
                    onChange={e => setCustomModel(e.target.value)}
                    placeholder="text-embedding-3-small"
                    style={{
                      fontSize: 'var(--text-sm)',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '10px 12px',
                      transition: 'border-color 0.2s, box-shadow 0.2s',
                    }}
                  />
                </div>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 500, letterSpacing: '0.02em' }}>
                    {isZh ? '向量维度' : 'Dimensions'}
                  </label>
                  <input
                    className="settings-input"
                    type="number"
                    value={customDimensions}
                    onChange={e => setCustomDimensions(Number(e.target.value))}
                    placeholder="1536"
                    style={{
                      fontSize: 'var(--text-sm)',
                      fontFamily: 'var(--font-mono)',
                      background: 'var(--bg-primary)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '10px 12px',
                      transition: 'border-color 0.2s, box-shadow 0.2s',
                    }}
                  />
                </div>
              </div>

              {/* Save button */}
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSaveCustomConfig}
                  style={{ minWidth: '100px' }}
                >
                  {configSaved ? (isZh ? '✓ 已保存' : '✓ Saved') : (isZh ? '保存配置' : 'Save Config')}
                </button>
              </div>
            </div>
          )}

          {/* Index stats with progress bar */}
          {stats && (
            <div style={{
              padding: 'var(--space-3)',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}>
              <div style={rowBetween}>
                <div style={rowLabel}>
                  <IconDatabase size={16} />
                  <span>{isZh ? '向量索引' : 'Vector Index'}</span>
                </div>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {stats.indexed_chunks} / {stats.total_chunks} ({progressPercent}%)
                </span>
              </div>
              {/* Progress bar */}
              <div style={{
                height: '6px',
                background: 'var(--bg-tertiary)',
                borderRadius: '3px',
                overflow: 'hidden',
              }}>
                <div style={{
                  width: `${progressPercent}%`,
                  height: '100%',
                  background: progressPercent === 100
                    ? 'var(--success, #22c55e)'
                    : 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary, var(--accent-primary)))',
                  borderRadius: '3px',
                  transition: 'width 0.5s ease',
                }} />
              </div>
              {!stats.has_index && (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IconWarning size={14} />
                  {isZh ? '索引尚未构建，请点击下方按钮生成' : 'Index not built yet. Click the button below to generate.'}
                </div>
              )}
            </div>
          )}

          {/* Build button */}
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className={`btn btn-sm ${building ? 'btn-secondary' : 'btn-primary'}`}
              onClick={handleBuildIndex}
              disabled={building}
              style={{ minWidth: '140px' }}
            >
              {building
                ? (<><span className="spinner" style={{ width: 14, height: 14 }} /> {isZh ? '构建中...' : 'Building...'}</>)
                : (<><IconSync size={14} /> {isZh ? '构建 / 刷新索引' : 'Build / Refresh Index'}</>)}
            </button>
          </div>

          {/* Build result */}
          {buildResult && (
            <div style={{
              fontSize: 'var(--text-xs)',
              color: buildResult.includes('Build failed') || buildResult.includes('构建失败') ? 'var(--danger)' : 'var(--success, #22c55e)',
              padding: 'var(--space-2) var(--space-3)',
              background: (buildResult.includes('Build failed') || buildResult.includes('构建失败')) ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)',
              borderRadius: 'var(--radius-sm)',
            }}>
              {buildResult}
            </div>
          )}

          {building && (
            <div style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-subtle)',
              padding: 'var(--space-3) var(--space-4)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-3)',
              fontSize: 'var(--text-xs)',
              marginTop: 'var(--space-2)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '80%' }}>
                <span style={{ color: 'var(--accent-primary)', display: 'inline-flex', flexShrink: 0 }}><IconSync size={13} spinning={true} /></span>
                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {buildStage}
                </span>
              </div>
              <button
                className="btn btn-xs btn-secondary"
                style={{ color: 'var(--danger)', flexShrink: 0, padding: '2px 8px', fontSize: '10px' }}
                onClick={() => {
                  cancelRef.current = true;
                  setBuildStage(isZh ? '正在中止任务...' : 'Cancelling task...');
                }}
              >
                {isZh ? '中止' : 'Cancel'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
