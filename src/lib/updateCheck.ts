import { getAppVersion } from './appVersion';
import {
  GITHUB_RELEASE,
  LATEST_RELEASE_API,
  RELEASES_PAGE_URL,
  STORAGE_DISMISS_UPDATE_VERSION,
  STORAGE_LAST_UPDATE_CHECK,
  UPDATE_CHECK_INTERVAL_MS,
} from './releaseConfig';

export type UpdateCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseUrl: string;
  releaseNotes: string;
  publishedAt: string;
};

type GitHubRelease = {
  tag_name: string;
  html_url: string;
  body: string | null;
  published_at: string;
  draft?: boolean;
  prerelease?: boolean;
};

function parseVersion(v: string): [number, number, number] {
  const clean = v.trim().replace(/^v/i, '').split('-')[0];
  const [major = '0', minor = '0', patch = '0'] = clean.split('.');
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0];
}

export function isVersionNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(STORAGE_DISMISS_UPDATE_VERSION) === version;
  } catch {
    return false;
  }
}

export function dismissUpdateVersion(version: string) {
  try {
    localStorage.setItem(STORAGE_DISMISS_UPDATE_VERSION, version);
  } catch {
    /* ignore */
  }
}

function shouldRunBackgroundCheck(force: boolean): boolean {
  if (force) return true;
  try {
    const last = localStorage.getItem(STORAGE_LAST_UPDATE_CHECK);
    if (!last) return true;
    return Date.now() - Number(last) > UPDATE_CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function markBackgroundCheckDone() {
  try {
    localStorage.setItem(STORAGE_LAST_UPDATE_CHECK, String(Date.now()));
  } catch {
    /* ignore */
  }
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(LATEST_RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}`);
  }
  return res.json() as Promise<GitHubRelease>;
}

/** Check GitHub Releases for a newer version. */
export async function checkForUpdate(options?: { force?: boolean }): Promise<UpdateCheckResult | null> {
  const force = options?.force ?? false;
  if (!shouldRunBackgroundCheck(force)) return null;

  const currentVersion = await getAppVersion();
  let release: GitHubRelease;
  try {
    release = await fetchLatestRelease();
    markBackgroundCheckDone();
  } catch {
    return null;
  }

  if (release.draft) return null;

  const latestVersion = release.tag_name.replace(/^v/i, '');
  const updateAvailable = isVersionNewer(latestVersion, currentVersion);

  return {
    currentVersion,
    latestVersion,
    updateAvailable,
    releaseUrl: release.html_url || RELEASES_PAGE_URL,
    releaseNotes: release.body?.trim() ?? '',
    publishedAt: release.published_at,
  };
}

/** Returns update info only if newer than current and not dismissed by user. */
export async function checkForUpdateNotification(options?: {
  force?: boolean;
}): Promise<UpdateCheckResult | null> {
  const result = await checkForUpdate(options);
  if (!result?.updateAvailable) return null;
  if (isDismissed(result.latestVersion)) return null;
  return result;
}

export async function openReleaseDownload(url?: string) {
  const target = url || RELEASES_PAGE_URL;
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(target);
  } catch {
    window.open(target, '_blank', 'noopener,noreferrer');
  }
}

export function getReleaseLabel(): string {
  return `${GITHUB_RELEASE.owner}/${GITHUB_RELEASE.repo}`;
}
