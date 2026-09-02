import type { GitHubConfig } from '../backends/github';

const PUBLIC_CONFIG_KEY = 'githubConfig';
const TOKEN_KEY = 'githubToken';
const REMOTE_VERSION_KEY = 'githubRemoteVersion';

export interface StoredGitHubConfig {
  apiUrl: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

export async function saveGitHubConfig(config: GitHubConfig): Promise<void> {
  const publicConfig: StoredGitHubConfig = {
    apiUrl: config.apiUrl,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    filePath: config.filePath,
  };
  const current = await browser.storage.local.get(PUBLIC_CONFIG_KEY);
  const previous = current[PUBLIC_CONFIG_KEY] as StoredGitHubConfig | undefined;
  const targetChanged = !previous || Object.entries(publicConfig).some(
    ([key, value]) => previous[key as keyof StoredGitHubConfig] !== value,
  );
  await browser.storage.local.set({ [PUBLIC_CONFIG_KEY]: publicConfig, [TOKEN_KEY]: config.token });
  if (targetChanged) await browser.storage.local.remove(REMOTE_VERSION_KEY);
}

export async function loadGitHubConfig(): Promise<GitHubConfig | null> {
  const stored = await browser.storage.local.get([PUBLIC_CONFIG_KEY, TOKEN_KEY]);
  const publicConfig = stored[PUBLIC_CONFIG_KEY] as StoredGitHubConfig | undefined;
  const token = stored[TOKEN_KEY];
  return publicConfig && typeof token === 'string' ? { ...publicConfig, token } : null;
}

export async function saveGitHubRemoteVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [REMOTE_VERSION_KEY]: version });
}

export async function loadGitHubRemoteVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(REMOTE_VERSION_KEY);
  return typeof stored[REMOTE_VERSION_KEY] === 'string' ? stored[REMOTE_VERSION_KEY] : null;
}

const BOOKMARKS_VERSION_githubBookmarksVersion = 'githubBookmarksVersion';

export async function saveGitHubBookmarksVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [BOOKMARKS_VERSION_githubBookmarksVersion]: version });
}

export async function loadGitHubBookmarksVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(BOOKMARKS_VERSION_githubBookmarksVersion);
  return typeof stored[BOOKMARKS_VERSION_githubBookmarksVersion] === 'string'
    ? stored[BOOKMARKS_VERSION_githubBookmarksVersion]
    : null;
}
