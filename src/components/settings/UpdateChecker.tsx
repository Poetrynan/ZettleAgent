import { useCallback, useEffect, useState } from 'react';
import { t } from '../../lib/i18n';
import { getAppVersion } from '../../lib/appVersion';
import {
  checkForUpdate,
  dismissUpdateVersion,
  openReleaseDownload,
  type UpdateCheckResult,
} from '../../lib/updateCheck';
import { RELEASES_PAGE_URL } from '../../lib/releaseConfig';

interface UpdateCheckerProps {
  isZh: boolean;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  /** Run automatic check once when settings tab mounts */
  autoCheck?: boolean;
  /** Hide secondary "all releases" link (shown in AboutSection instead) */
  compact?: boolean;
}

export function UpdateChecker({ isZh, showToast, autoCheck = false, compact = false }: UpdateCheckerProps) {
  const [currentVersion, setCurrentVersion] = useState('…');
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getAppVersion().then(setCurrentVersion);
  }, []);

  const runCheck = useCallback(async (force = true) => {
    setChecking(true);
    setError(null);
    try {
      const info = await checkForUpdate({ force });
      if (!info) {
        if (force) {
          setError(isZh ? '无法连接 GitHub，请稍后重试' : 'Could not reach GitHub. Try again later.');
        }
        return;
      }
      setResult(info);
      setCurrentVersion(info.currentVersion);
      if (!info.updateAvailable) {
        showToast(t('update.upToDate'), 'success');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  }, [isZh, showToast]);

  useEffect(() => {
    if (autoCheck) {
      void runCheck(false);
    }
  }, [autoCheck, runCheck]);

  const handleDismiss = () => {
    if (result?.latestVersion) {
      dismissUpdateVersion(result.latestVersion);
    }
    setResult(prev => (prev ? { ...prev, updateAvailable: false } : prev));
  };

  return (
    <div className="update-checker">
      <div className="update-checker-row">
        <span style={{ color: 'var(--text-secondary)' }}>{t('settings.version')}</span>
        <span className="badge badge-primary">v{currentVersion}</span>
      </div>

      {result?.updateAvailable && (
        <div className="update-checker-banner" role="status">
          <div className="update-checker-banner-title">
            {t('update.newVersion').replace('{version}', result.latestVersion)}
          </div>
          {result.releaseNotes && (
            <div className="update-checker-notes">
              {result.releaseNotes.slice(0, 280)}
              {result.releaseNotes.length > 280 ? '…' : ''}
            </div>
          )}
          <div className="update-checker-actions">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => openReleaseDownload(result.releaseUrl)}
            >
              {t('update.download')}
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={handleDismiss}>
              {t('update.dismiss')}
            </button>
          </div>
        </div>
      )}

      <div className="update-checker-actions update-checker-actions--footer">
        <button
          type="button"
          className="btn btn-sm btn-secondary"
          disabled={checking}
          onClick={() => runCheck(true)}
        >
          {checking ? t('update.checking') : t('update.checkNow')}
        </button>
        {!compact && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => openReleaseDownload(RELEASES_PAGE_URL)}
          >
            {t('update.allReleases')}
          </button>
        )}
      </div>

      {error && (
        <div className="update-checker-error">{error}</div>
      )}
    </div>
  );
}
