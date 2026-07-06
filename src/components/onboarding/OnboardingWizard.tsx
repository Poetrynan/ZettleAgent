import { useState, useCallback, useEffect } from 'react';
import { t, getLang, setLang } from '../../lib/i18n';
import { LLM_PROVIDERS, getProvider } from '../../lib/llm-providers';
import { saveLlmConfig, saveMethodology, saveOnboardingComplete } from '../../lib/storage';
import { initDemoVault, setVaultPath, syncVault } from '../../lib/tauri';
import { getThemeMode, setThemeMode, type ThemeMode } from '../../lib/theme';
import { IconSun, IconMoon, IconSliders } from '../icons';

interface OnboardingWizardProps {
  onComplete: () => void;
}

// ── Methodology definitions ────────────────────────────────────────

const METHODOLOGIES = [
  {
    key: 'zettelkasten',
    label: 'Zettelkasten',
    descEn: 'Permanent, Literature, Fleeting, and Structure notes.',
    descZh: '卡片盒：永久、文献、闪念、结构笔记。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="8" y1="3" x2="8" y2="21"/><line x1="2" y1="9" x2="8" y2="9"/><line x1="2" y1="15" x2="8" y2="15"/></svg>`,
  },
  {
    key: 'para',
    label: 'PARA',
    descEn: 'Projects, Areas, Resources, and Archives.',
    descZh: '项目、领域、资源、归档。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>`,
  },
  {
    key: 'generic',
    label: { en: 'Generic', zh: '通用' },
    descEn: 'Concepts, References, Tasks, and Journals.',
    descZh: '概念、文献、任务、日志。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`,
  },
  {
    key: 'code',
    label: 'CODE',
    descEn: 'Capture → Organize → Distill → Express.',
    descZh: '捕获 → 组织 → 提炼 → 表达。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  },
  {
    key: 'evergreen',
    label: { en: 'Evergreen', zh: '常青笔记' },
    descEn: 'Seed → Sapling → Evergreen → Compost.',
    descZh: '种子 → 树苗 → 常青 → 堆肥。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 8c0-5-5-5-5-5s-5 0-5 5c0 3 2 5 5 8 3-3 5-5 5-8z"/><line x1="12" y1="16" x2="12" y2="22"/></svg>`,
  },
  {
    key: 'gtd',
    label: 'GTD',
    descEn: 'Inbox → Next Action → Waiting → Someday.',
    descZh: '收件箱 → 下一步 → 等待 → 将来。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>`,
  },
  {
    key: 'cornell',
    label: { en: 'Cornell', zh: '康奈尔' },
    descEn: 'Cue → Note → Summary → Review.',
    descZh: '线索 → 笔记 → 总结 → 复习。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`,
  },
  {
    key: 'moc',
    label: { en: 'MOC / LYT', zh: 'MOC / LYT' },
    descEn: 'Note → Map of Content → Hub → Dashboard.',
    descZh: '笔记 → 内容地图 → 枢纽 → 仪表盘。',
    icon: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>`,
  },
];

// ── Step labels ────────────────────────────────────────────────────
const STEP_LABELS_ZH = ['欢迎', 'LLM', 'Embedding', '流派'];
const STEP_LABELS_EN = ['Welcome', 'LLM', 'Embedding', 'Methodology'];

const THEME_OPTIONS: { id: ThemeMode; labelKey: 'settings.themeLight' | 'settings.themeDark' | 'settings.themeSystem'; Icon: typeof IconSun }[] = [
  { id: 'light', labelKey: 'settings.themeLight', Icon: IconSun },
  { id: 'dark', labelKey: 'settings.themeDark', Icon: IconMoon },
  { id: 'system', labelKey: 'settings.themeSystem', Icon: IconSliders },
];

// ── Main Component ─────────────────────────────────────────────────

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [lang, setLangState] = useState(getLang());
  const isZh = lang === 'zh';
  const [step, setStep] = useState(0); // 0=welcome, 1=llm, 2=embedding, 3=methodology

  const toggleLang = useCallback(() => {
    const newLang = lang === 'zh' ? 'en' : 'zh';
    setLang(newLang);
    setLangState(newLang);
  }, [lang]);

  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getThemeMode());

  useEffect(() => {
    const onThemeChange = () => setThemeModeState(getThemeMode());
    window.addEventListener('zettel:theme-changed', onThemeChange);
    return () => window.removeEventListener('zettel:theme-changed', onThemeChange);
  }, []);

  const handleThemeChange = useCallback((mode: ThemeMode) => {
    setThemeMode(mode);
    setThemeModeState(mode);
  }, []);

  // LLM state
  const [providerId, setProviderId] = useState('ollama');
  const [apiUrl, setApiUrl] = useState('http://127.0.0.1:11434/v1/chat/completions');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-v4-pro');

  // Methodology
  const [methodology, setMethodology] = useState('zettelkasten');

  // Skip warning
  const [showSkipWarn, setShowSkipWarn] = useState(false);

  const currentProvider = getProvider(providerId);

  const handleProviderSelect = useCallback((id: string) => {
    const provider = getProvider(id);
    if (!provider) return;
    setProviderId(id);
    setApiUrl(provider.baseUrl);
    setModel(provider.models[0]?.id || '');
    setApiKey('');
  }, []);

  const [finishing, setFinishing] = useState(false);

  const handleFinish = useCallback(async () => {
    setFinishing(true);
    await saveLlmConfig({ providerId, apiUrl, apiKey, model });
    await saveMethodology(methodology);
    await saveOnboardingComplete();
    // Initialize demo vault if no vault is configured
    try {
      const demoPath = await initDemoVault();
      await setVaultPath(demoPath);
      await syncVault(demoPath);
    } catch (e) {
      console.warn('Failed to init demo vault:', e);
    }
    // Show success state for 800ms before transitioning
    setTimeout(() => {
      onComplete();
    }, 800);
  }, [providerId, apiUrl, apiKey, model, methodology, onComplete]);

  const handleSkipLlm = useCallback(() => {
    if (!showSkipWarn) {
      setShowSkipWarn(true);
      return;
    }
    setShowSkipWarn(false);
    setStep(2);
  }, [showSkipWarn]);

  const goNext = () => { setShowSkipWarn(false); setStep((s) => Math.min(s + 1, 3)); };
  const goBack = () => { setShowSkipWarn(false); setStep((s) => Math.max(s - 1, 0)); };

  const stepLabels = isZh ? STEP_LABELS_ZH : STEP_LABELS_EN;

  return (
    <div className={`onboarding-root ${finishing ? 'onboarding-finishing' : ''}`}>
      {/* Finishing overlay */}
      {finishing && (
        <div className="onboarding-finish-overlay">
          <div className="onboarding-finish-check">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <p className="onboarding-finish-text">
            {isZh ? '设置完成！' : 'Setup Complete!'}
          </p>
        </div>
      )}

      <div className="onboarding-grid-mesh" aria-hidden="true" />

      {/* Animated background */}
      <div className="onboarding-bg" aria-hidden="true">
        <div className="onboarding-orb onboarding-orb-1" />
        <div className="onboarding-orb onboarding-orb-2" />
        <div className="onboarding-orb onboarding-orb-3" />
      </div>

      <div className="onboarding-card">
        <div className="onboarding-top-actions">
          <div className="onboarding-theme-toggle" role="radiogroup" aria-label={t('settings.appearance')}>
            {THEME_OPTIONS.map(({ id, labelKey, Icon }) => (
              <button
                key={id}
                type="button"
                className={`onboarding-theme-btn ${themeMode === id ? 'active' : ''}`}
                role="radio"
                aria-checked={themeMode === id}
                title={t(labelKey)}
                onClick={() => handleThemeChange(id)}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          <button
            className="onboarding-lang-toggle"
            onClick={toggleLang}
            title={isZh ? 'Switch to English' : '切换到中文'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            <span>{isZh ? 'EN' : '中文'}</span>
          </button>
        </div>

        {/* Step progress bar */}
        <nav className="onboarding-progress" aria-label={isZh ? '设置进度' : 'Setup progress'}>
          {stepLabels.map((label, i) => {
            const isDone = i < step;
            const isActive = i === step;
            return (
              <div key={i} className="onboarding-step-item">
                {isDone ? (
                  <button
                    type="button"
                    className="onboarding-step-btn"
                    onClick={() => setStep(i)}
                    aria-label={isZh ? `返回：${label}` : `Go back to ${label}`}
                  >
                    <span className="onboarding-step-dot done" aria-hidden="true">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                    </span>
                    <span className="onboarding-step-label active">{label}</span>
                  </button>
                ) : (
                  <>
                    <span
                      className={`onboarding-step-dot ${isActive ? 'active' : ''}`}
                      aria-current={isActive ? 'step' : undefined}
                    >
                      <span aria-hidden="true">{i + 1}</span>
                    </span>
                    <span className={`onboarding-step-label ${isActive ? 'active' : ''}`}>{label}</span>
                  </>
                )}
                {i < 3 && <div className={`onboarding-step-line ${isDone ? 'done' : ''}`} aria-hidden="true" />}
              </div>
            );
          })}
        </nav>

        {/* Page content */}
        <div className="onboarding-content" key={step}>
          {step === 0 && <WelcomePage onStart={() => setStep(1)} isZh={isZh} />}
          {step === 1 && (
            <LlmPage
              isZh={isZh}
              providerId={providerId}
              apiUrl={apiUrl}
              apiKey={apiKey}
              model={model}
              currentProvider={currentProvider}
              onProviderSelect={handleProviderSelect}
              onApiUrlChange={setApiUrl}
              onApiKeyChange={setApiKey}
              onModelChange={setModel}
              showSkipWarn={showSkipWarn}
            />
          )}
          {step === 2 && (
            <EmbeddingInfoPage isZh={isZh} />
          )}
          {step === 3 && (
            <MethodologyPage isZh={isZh} selected={methodology} onSelect={setMethodology} />
          )}
        </div>

        {/* Navigation footer — hidden on welcome step */}
        {step !== 0 && (
        <div className="onboarding-nav">
            <>
              <button className="onboarding-btn onboarding-btn-ghost" onClick={goBack}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
                {t('onboarding.back')}
              </button>
              <div style={{ flex: 1 }} />
              {step === 1 && (
                <button
                  className="onboarding-btn onboarding-btn-ghost"
                  onClick={handleSkipLlm}
                  style={{ color: showSkipWarn ? 'var(--danger)' : undefined }}
                >
                  {showSkipWarn ? (isZh ? '确认跳过' : 'Confirm Skip') : t('onboarding.skip')}
                </button>
              )}
              {step === 2 && (
                <button className="onboarding-btn onboarding-btn-ghost" onClick={goNext}>
                  {t('onboarding.skip')}
                </button>
              )}
              {step < 3 ? (
                <button className="onboarding-btn onboarding-btn-primary" onClick={goNext}>
                  {t('onboarding.next')}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
                </button>
              ) : (
                <button className="onboarding-btn onboarding-btn-primary" onClick={handleFinish}>
                  {t('onboarding.finish')}
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </button>
              )}
            </>
        </div>
        )}
      </div>
    </div>
  );
}

// ── Page 1: Welcome ────────────────────────────────────────────────

function WelcomePage({ onStart, isZh }: { onStart: () => void; isZh: boolean }) {
  const features = [
    { icon: ICONS.brain, title: t('onboarding.feature1'), desc: t('onboarding.feature1Sub' as any), delay: '150ms' },
    { icon: ICONS.graph, title: t('onboarding.feature2'), desc: t('onboarding.feature2Sub' as any), delay: '250ms' },
    { icon: ICONS.chat, title: t('onboarding.feature3'), desc: t('onboarding.feature3Sub' as any), delay: '350ms' },
  ];

  return (
    <div className="onboarding-welcome animate-enter">
      <header className="onboarding-welcome-hero">
        <p className="onboarding-welcome-greeting">{isZh ? '欢迎使用' : 'Welcome to'}</p>
        <h1 id="onboarding-welcome-heading" className="onboarding-welcome-title">
          <span className="logo-zettel onboarding-welcome-zettel">Zettel</span>
          <span className="logo-lambda-wrap"><span className="logo-agent-lambda">Λ</span></span>
          <span className="logo-agent-rest">gent</span>
        </h1>
        <div className="onboarding-welcome-tagline-row">
          <span className="onboarding-welcome-tagline-rule onboarding-welcome-tagline-rule--left" aria-hidden="true" />
          <p className="onboarding-welcome-tagline">Think · Connect · Evolve</p>
          <span className="onboarding-welcome-tagline-rule onboarding-welcome-tagline-rule--right" aria-hidden="true" />
        </div>
      </header>

      <div className="onboarding-welcome-intro">
        <p className="onboarding-hero-subtitle">{t('onboarding.tagline')}</p>
        <p className="onboarding-hero-hint">{t('onboarding.letsSetup')}</p>
      </div>

      <ul className="onboarding-features" aria-label={isZh ? '核心功能' : 'Key features'}>
        {features.map((f, i) => (
          <li
            key={i}
            className="onboarding-feature-item animate-enter"
            style={{ animationDelay: f.delay }}
          >
            <div className="onboarding-feature-icon" dangerouslySetInnerHTML={{ __html: f.icon }} />
            <div className="onboarding-feature-body">
              <span className="onboarding-feature-title">{f.title}</span>
              <span className="onboarding-feature-desc">{f.desc}</span>
            </div>
          </li>
        ))}
      </ul>

      <div className="onboarding-welcome-spacer" aria-hidden="true" />

      <div className="onboarding-welcome-bottom">
        <button
          type="button"
          className="onboarding-btn onboarding-btn-primary onboarding-btn-lg"
          onClick={onStart}
          aria-describedby="onboarding-welcome-hint"
        >
          {t('onboarding.startSetup')}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
        </button>
        <p id="onboarding-welcome-hint" className="onboarding-welcome-footnote">{t('onboarding.configLater')}</p>
      </div>
    </div>
  );
}

// ── Page 2: LLM Config ────────────────────────────────────────────

interface LlmPageProps {
  isZh: boolean;
  providerId: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  currentProvider: ReturnType<typeof getProvider>;
  onProviderSelect: (id: string) => void;
  onApiUrlChange: (v: string) => void;
  onApiKeyChange: (v: string) => void;
  onModelChange: (v: string) => void;
  showSkipWarn: boolean;
}

function LlmPage(props: LlmPageProps) {
  const { providerId, apiUrl, apiKey, model, currentProvider, showSkipWarn } = props;
  const isZh = props.isZh;

  return (
    <div className="animate-enter">
      <div className="onboarding-page-header">
        <div className="onboarding-page-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a7 7 0 017 7c0 2.4-1.2 4.5-3 6l-1 1.5V19H9v-2.5L8 15c-1.8-1.5-3-3.6-3-6a7 7 0 017-7z"/><line x1="9" y1="22" x2="15" y2="22"/></svg>
        </div>
        <h2 className="onboarding-page-title">{t('onboarding.llmTitle')}</h2>
      </div>
      <p className="onboarding-page-desc">{t('onboarding.llmDesc')}</p>

      {/* Warning banner */}
      <div className="onboarding-alert onboarding-alert-warn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span>{t('onboarding.llmRequired')}</span>
      </div>

      {showSkipWarn && (
        <div className="onboarding-alert onboarding-alert-danger animate-enter">
          {t('onboarding.llmSkipWarn')}
        </div>
      )}

      {/* Provider grid */}
      <div className="onboarding-provider-grid">
        {LLM_PROVIDERS.map((p) => (
          <button
            key={p.id}
            className={`onboarding-provider-chip ${providerId === p.id ? 'selected' : ''}`}
            onClick={() => props.onProviderSelect(p.id)}
          >
            {isZh ? p.nameZh : p.name}
          </button>
        ))}
      </div>

      {/* Provider info */}
      {currentProvider && (
        <div className="onboarding-provider-info">
          <span>{isZh ? currentProvider.descriptionZh : currentProvider.description}</span>
          {currentProvider.keyUrl && (
            <a href={currentProvider.keyUrl} target="_blank" rel="noopener noreferrer" className="onboarding-btn onboarding-btn-sm onboarding-btn-primary" style={{ textDecoration: 'none' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 010-7.778zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
              {isZh ? '获取 Key' : 'Get Key'}
            </a>
          )}
        </div>
      )}

      {/* Form fields */}
      <div className="onboarding-form-group">
        <label className="onboarding-label">API Endpoint</label>
        <input className="onboarding-input" value={apiUrl} onChange={(e) => props.onApiUrlChange(e.target.value)} placeholder="https://api.example.com/v1/chat/completions" />
      </div>

      {currentProvider?.needsApiKey !== false && (
        <div className="onboarding-form-group">
          <label className="onboarding-label">API Key</label>
          <input className="onboarding-input" type="password" value={apiKey} onChange={(e) => props.onApiKeyChange(e.target.value)} placeholder="sk-..." />
        </div>
      )}

      {currentProvider && currentProvider.models.length > 0 && (
        <div className="onboarding-form-group">
          <label className="onboarding-label">{isZh ? '模型' : 'Model'}</label>
          <div className="onboarding-model-chips">
            {currentProvider.models.map((m) => (
              <button key={m.id} className={`onboarding-model-chip ${model === m.id ? 'selected' : ''}`} onClick={() => props.onModelChange(m.id)} title={m.description}>
                {m.name}
              </button>
            ))}
          </div>
          <input
            className="onboarding-input"
            value={currentProvider.models.some((m) => m.id === model) ? '' : model}
            onChange={(e) => props.onModelChange(e.target.value)}
            placeholder={isZh ? '或输入自定义模型名称...' : 'Or enter custom model name...'}
          />
        </div>
      )}
      {currentProvider && currentProvider.models.length === 0 && (
        <div className="onboarding-form-group">
          <label className="onboarding-label">{isZh ? '模型名称' : 'Model Name'}</label>
          <input className="onboarding-input" value={model} onChange={(e) => props.onModelChange(e.target.value)} placeholder={isZh ? '输入模型名称，如 gpt-4o' : 'Enter model name, e.g. gpt-4o'} />
        </div>
      )}
    </div>
  );
}

function EmbeddingInfoPage({ isZh }: { isZh: boolean }) {
  const specs = [
    {
      label: isZh ? '向量维度' : 'Dimensions',
      value: '768',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
      ),
    },
    {
      label: isZh ? '运行方式' : 'Runtime',
      value: isZh ? '完全离线' : 'Fully offline',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      ),
    },
    {
      label: isZh ? '加速引擎' : 'Acceleration',
      value: 'WebGPU / WASM',
      icon: (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      ),
    },
  ];

  return (
    <div className="animate-enter onboarding-embed-page">
      <div className="onboarding-page-header">
        <div className="onboarding-page-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
        </div>
        <h2 className="onboarding-page-title">{isZh ? '嵌入向量引擎' : 'Embedding Engine'}</h2>
      </div>
      <p className="onboarding-page-desc">
        {isZh
          ? '语义搜索引擎已内置，无需额外配置。'
          : 'The semantic search engine is built-in. No extra configuration needed.'}
      </p>

      <div className="onboarding-embed-showcase">
        <div className="onboarding-embed-hero">
          <div className="onboarding-embed-hero-icon">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a7 7 0 017 7c0 2.4-1.2 4.5-3 6l-1 1.5V19H9v-2.5L8 15c-1.8-1.5-3-3.6-3-6a7 7 0 017-7z"/>
              <line x1="9" y1="22" x2="15" y2="22"/>
            </svg>
          </div>
          <div className="onboarding-embed-hero-body">
            <h3 className="onboarding-embed-model-name">nomic-embed-text-v1.5</h3>
            <p className="onboarding-embed-model-tag">INT8 Quantized</p>
          </div>
          <div className="onboarding-embed-status">
            <span className="onboarding-embed-status-dot" aria-hidden="true" />
            {isZh ? '开箱即用' : 'Ready to use'}
          </div>
        </div>

        <div className="onboarding-embed-specs">
          {specs.map((spec) => (
            <div key={spec.label} className="onboarding-embed-spec">
              <div className="onboarding-embed-spec-icon">{spec.icon}</div>
              <div className="onboarding-embed-spec-value">{spec.value}</div>
              <div className="onboarding-embed-spec-label">{spec.label}</div>
            </div>
          ))}
        </div>
      </div>

      <p className="onboarding-embed-hint">
        {isZh
          ? '默认使用内置模型，无需 API 密钥。你也可以在设置中切换为自定义嵌入 API（如 OpenAI Embeddings）。'
          : 'Built-in model works out of the box with no API key. You can switch to a custom embedding API (e.g. OpenAI) in Settings.'}
      </p>
    </div>
  );
}

// ── Page 4: Methodology ────────────────────────────────────────────

function MethodologyPage({ isZh, selected, onSelect }: { isZh: boolean; selected: string; onSelect: (v: string) => void }) {
  return (
    <div className="animate-enter">
      <div className="onboarding-page-header">
        <div className="onboarding-page-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
        </div>
        <h2 className="onboarding-page-title">{t('onboarding.methodologyTitle')}</h2>
      </div>
      <p className="onboarding-page-desc">{t('onboarding.methodologyDesc')}</p>

      <div className="onboarding-methodology-grid">
        {METHODOLOGIES.map((m) => {
          const label = typeof m.label === 'string' ? m.label : (isZh ? m.label.zh : m.label.en);
          const desc = isZh ? m.descZh : m.descEn;
          const isSelected = selected === m.key;

          return (
            <button key={m.key} className={`onboarding-methodology-card ${isSelected ? 'selected' : ''}`} onClick={() => onSelect(m.key)}>
              <div className="onboarding-methodology-icon" dangerouslySetInnerHTML={{ __html: m.icon }} />
              <div className="onboarding-methodology-body">
                <div className="onboarding-methodology-name">{label}</div>
                <div className="onboarding-methodology-desc">{desc}</div>
              </div>
              {isSelected && (
                <div className="onboarding-check">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </div>
              )}
            </button>
          );
        })}
      </div>

      <p className="onboarding-hint">{t('onboarding.configLater')}</p>
    </div>
  );
}

// ── SVG Icons ──────────────────────────────────────────────────────

const ICONS = {
  brain: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 017 7c0 2.4-1.2 4.5-3 6l-1 1.5V19H9v-2.5L8 15c-1.8-1.5-3-3.6-3-6a7 7 0 017-7z"/><line x1="9" y1="22" x2="15" y2="22"/></svg>`,
  graph: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="16.5"/><line x1="15.5" y1="7.5" x2="18" y2="15"/></svg>`,
  chat: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2v10z"/><line x1="9" y1="10" x2="15" y2="10"/></svg>`,
};
