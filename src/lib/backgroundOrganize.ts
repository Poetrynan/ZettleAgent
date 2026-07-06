import { startScheduler, getSchedulerStatus, syncVault } from './tauri';
import { getSmartOrganizeConfig, setBackgroundOrganizeEnabled } from '../components/settings/Settings';
import type { LlmConfig } from '../contexts/BaseContext';

export function isLlmConfigured(cfg: { apiUrl: string; model: string }): boolean {
  const url = (cfg.apiUrl || '').trim();
  const model = (cfg.model || '').trim();
  if (!url || !model) return false;
  if (url.includes('example.com') || url.includes('placeholder')) return false;
  return true;
}

/** Start the hourly background auto-organize loop. */
export async function startBackgroundOrganize(params: {
  vaultPaths: string[];
  llmConfig: LlmConfig;
  methodology: string;
}): Promise<void> {
  const { vaultPaths, llmConfig, methodology } = params;
  if (vaultPaths.length === 0) {
    throw new Error('No vault path configured');
  }
  if (!isLlmConfigured(llmConfig)) {
    throw new Error('LLM API is not configured');
  }

  const orgConfig = getSmartOrganizeConfig();
  for (const vp of vaultPaths) {
    await syncVault(vp);
  }

  let dailyPath: string | undefined;
  if (!orgConfig.includeJournals) {
    const { getDailyFolderPath } = await import('./dailyNote');
    dailyPath = await getDailyFolderPath();
  }

  await startScheduler({
    intervalSecs: orgConfig.intervalSecs,
    batchSize: orgConfig.batchSize,
    maxApiCalls: 20,
    apiUrl: llmConfig.apiUrl,
    apiKey: llmConfig.apiKey || undefined,
    model: llmConfig.model,
    providerId: llmConfig.providerId,
    methodology,
    searchResultCount: orgConfig.searchResultCount,
    contentTruncationLimit: orgConfig.contentTruncationLimit,
    includeJournals: orgConfig.includeJournals,
    dailyNotePath: dailyPath,
    vaultPaths,
    minNoteLength: orgConfig.minNoteLength,
  });
  setBackgroundOrganizeEnabled(true);
}

/** Resume hourly background organize after app restart, if user had it enabled. */
export async function resumeBackgroundOrganizeIfEnabled(params: {
  vaultPaths: string[];
  llmConfig: LlmConfig;
  methodology: string;
}): Promise<boolean> {
  const { getBackgroundOrganizeEnabled } = await import('../components/settings/Settings');
  if (!getBackgroundOrganizeEnabled()) return false;
  if (params.vaultPaths.length === 0 || !isLlmConfigured(params.llmConfig)) return false;

  const status = await getSchedulerStatus();
  if (status.running) return true;

  try {
    await startBackgroundOrganize(params);
    return true;
  } catch (e) {
    console.error('[backgroundOrganize] Failed to resume hourly scheduler:', e);
    setBackgroundOrganizeEnabled(false);
    return false;
  }
}
