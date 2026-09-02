import type { GiteaConfig } from '../backends/gitea';

const PUBLIC_CONFIG_KEY = 'giteaConfig';
const TOKEN_KEY = 'giteaToken';
const REMOTE_VERSION_KEY = 'giteaRemoteVersion';

export interface StoredGiteaConfig {
  baseUrl: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

export async function saveGiteaConfig(config: GiteaConfig): Promise<void> {
  const publicConfig: StoredGiteaConfig = {
    baseUrl: config.baseUrl,
    owner: config.owner,
    repo: config.repo,
    branch: config.branch,
    filePath: config.filePath,
  };
  const current = await browser.storage.local.get(PUBLIC_CONFIG_KEY);
  const previous = current[PUBLIC_CONFIG_KEY] as StoredGiteaConfig | undefined;
  const targetChanged = !previous || Object.entries(publicConfig).some(
    ([key, value]) => previous[key as keyof StoredGiteaConfig] !== value,
  );
  await browser.storage.local.set({
    [PUBLIC_CONFIG_KEY]: publicConfig,
    [TOKEN_KEY]: config.token,
  });
  if (targetChanged) await browser.storage.local.remove(REMOTE_VERSION_KEY);
}

export async function loadGiteaConfig(): Promise<GiteaConfig | null> {
  const stored = await browser.storage.local.get([PUBLIC_CONFIG_KEY, TOKEN_KEY]);
  const publicConfig = stored[PUBLIC_CONFIG_KEY] as StoredGiteaConfig | undefined;
  const token = stored[TOKEN_KEY];
  if (!publicConfig || typeof token !== 'string') return null;
  return { ...publicConfig, token };
}

export async function saveGiteaRemoteVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [REMOTE_VERSION_KEY]: version });
}

export async function loadGiteaRemoteVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(REMOTE_VERSION_KEY);
  return typeof stored[REMOTE_VERSION_KEY] === 'string'
    ? stored[REMOTE_VERSION_KEY]
    : null;
}

const BOOKMARKS_VERSION_giteaBookmarksVersion = 'giteaBookmarksVersion';

export async function saveGiteaBookmarksVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [BOOKMARKS_VERSION_giteaBookmarksVersion]: version });
}

export async function loadGiteaBookmarksVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(BOOKMARKS_VERSION_giteaBookmarksVersion);
  return typeof stored[BOOKMARKS_VERSION_giteaBookmarksVersion] === 'string'
    ? stored[BOOKMARKS_VERSION_giteaBookmarksVersion]
    : null;
}
