/** GitHub Releases source — keep in sync with README / CI publish repo. */
export const GITHUB_RELEASE = {
  owner: 'Poetrynan',
  repo: 'ZettleAgent',
} as const;

export const GITHUB_REPO_URL =
  `https://github.com/${GITHUB_RELEASE.owner}/${GITHUB_RELEASE.repo}`;

export const RELEASES_PAGE_URL = `${GITHUB_REPO_URL}/releases`;

export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

export const LATEST_RELEASE_API =
  `https://api.github.com/repos/${GITHUB_RELEASE.owner}/${GITHUB_RELEASE.repo}/releases/latest`;

/** Minimum interval between background checks (24h). */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const STORAGE_LAST_UPDATE_CHECK = 'zettelagent-update-check-at';
export const STORAGE_DISMISS_UPDATE_VERSION = 'zettelagent-dismiss-update-version';
