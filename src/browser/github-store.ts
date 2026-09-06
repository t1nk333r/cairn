import type { GitHubConfig } from '../backends/github';
import { versionStore } from './version-store';

const PUBLIC_CONFIG_KEY = 'githubConfig';
const TOKEN_KEY = 'githubToken';

export const githubInventoryVersion = versionStore('githubRemoteVersion');
export const githubBookmarksVersion = versionStore('githubBookmarksVersion');

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
  if (targetChanged) await githubInventoryVersion.clear();
}

export async function loadGitHubConfig(): Promise<GitHubConfig | null> {
  const stored = await browser.storage.local.get([PUBLIC_CONFIG_KEY, TOKEN_KEY]);
  const publicConfig = stored[PUBLIC_CONFIG_KEY] as StoredGitHubConfig | undefined;
  const token = stored[TOKEN_KEY];
  return publicConfig && typeof token === 'string' ? { ...publicConfig, token } : null;
}
