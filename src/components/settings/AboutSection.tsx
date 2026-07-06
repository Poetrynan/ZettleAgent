import { t } from '../../lib/i18n';
import { openReleaseDownload } from '../../lib/updateCheck';
import {
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
  RELEASES_PAGE_URL,
} from '../../lib/releaseConfig';
import { IconExternalLink } from '../icons';
import { UpdateChecker } from './UpdateChecker';

interface AboutSectionProps {
  isZh: boolean;
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const LINKS = [
  { key: 'about.github', url: GITHUB_REPO_URL },
  { key: 'about.reportIssue', url: GITHUB_ISSUES_URL },
  { key: 'update.allReleases', url: RELEASES_PAGE_URL },
] as const;

export function AboutSection({ isZh, showToast }: AboutSectionProps) {
  return (
    <div className="about-section">
      <header className="about-hero">
        <h3 className="about-name">{t('app.name')}</h3>
        <p className="about-tagline">{t('about.tagline')}</p>
      </header>

      <blockquote className="about-philosophy" cite="Niklas Luhmann">
        <p className="about-philosophy-label">{t('about.philosophyLabel')}</p>
        <p className="about-philosophy-text">{t('about.philosophy')}</p>
        <footer className="about-philosophy-attribution">{t('about.philosophyAttribution')}</footer>
      </blockquote>

      <UpdateChecker isZh={isZh} showToast={showToast} autoCheck compact />

      <nav className="about-links" aria-label={t('settings.about')}>
        {LINKS.map(link => (
          <button
            key={link.key}
            type="button"
            className="about-link"
            onClick={() => openReleaseDownload(link.url)}
          >
            <span>{t(link.key)}</span>
            <IconExternalLink size={14} aria-hidden />
          </button>
        ))}
      </nav>

      <p className="about-privacy">{t('about.privacy')}</p>
    </div>
  );
}
