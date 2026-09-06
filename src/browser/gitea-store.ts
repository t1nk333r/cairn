import type { GiteaConfig } from '../backends/gitea';
import { versionStore } from './version-store';

const PUBLIC_CONFIG_KEY = 'giteaConfig';
const TOKEN_KEY = 'giteaToken';

export const giteaInventoryVersion = versionStore('giteaRemoteVersion');
export const giteaBookmarksVersion = versionStore('giteaBookmarksVersion');

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
  if (targetChanged) await giteaInventoryVersion.clear();
}

export async function loadGiteaConfig(): Promise<GiteaConfig | null> {
  const stored = await browser.storage.local.get([PUBLIC_CONFIG_KEY, TOKEN_KEY]);
  const publicConfig = stored[PUBLIC_CONFIG_KEY] as StoredGiteaConfig | undefined;
  const token = stored[TOKEN_KEY];
  if (!publicConfig || typeof token !== 'string') return null;
  return { ...publicConfig, token };
}
