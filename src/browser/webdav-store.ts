import type { WebDavConfig } from '../backends/webdav';
import { versionStore } from './version-store';

const PUBLIC_CONFIG_KEY = 'webdavConfig';
const SECRET_KEY = 'webdavPassword';

export const webdavInventoryVersion = versionStore('webdavRemoteVersion');
export const webdavBookmarksVersion = versionStore('webdavBookmarksVersion');

export interface StoredWebDavConfig {
  baseUrl: string;
  fileName: string;
  username: string;
}

export async function saveWebDavConfig(config: WebDavConfig): Promise<void> {
  const publicConfig: StoredWebDavConfig = {
    baseUrl: config.baseUrl,
    fileName: config.fileName,
    username: config.username,
  };
  const current = await browser.storage.local.get(PUBLIC_CONFIG_KEY);
  const previous = current[PUBLIC_CONFIG_KEY] as StoredWebDavConfig | undefined;
  const endpointChanged =
    !previous ||
    previous.baseUrl !== publicConfig.baseUrl ||
    previous.fileName !== publicConfig.fileName ||
    previous.username !== publicConfig.username;
  await browser.storage.local.set({
    [PUBLIC_CONFIG_KEY]: publicConfig,
    [SECRET_KEY]: config.password,
  });
  if (endpointChanged) await webdavInventoryVersion.clear();
}

export async function loadWebDavConfig(): Promise<WebDavConfig | null> {
  const stored = await browser.storage.local.get([PUBLIC_CONFIG_KEY, SECRET_KEY]);
  const publicConfig = stored[PUBLIC_CONFIG_KEY] as StoredWebDavConfig | undefined;
  const password = stored[SECRET_KEY];
  if (
    !publicConfig ||
    typeof publicConfig.baseUrl !== 'string' ||
    typeof publicConfig.fileName !== 'string' ||
    typeof publicConfig.username !== 'string' ||
    typeof password !== 'string'
  ) {
    return null;
  }
  return { ...publicConfig, password };
}
