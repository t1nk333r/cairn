import type { WebDavConfig } from '../backends/webdav';

const PUBLIC_CONFIG_KEY = 'webdavConfig';
const SECRET_KEY = 'webdavPassword';
const REMOTE_VERSION_KEY = 'webdavRemoteVersion';

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
  if (endpointChanged) await browser.storage.local.remove(REMOTE_VERSION_KEY);
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

export async function saveWebDavRemoteVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [REMOTE_VERSION_KEY]: version });
}

export async function loadWebDavRemoteVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(REMOTE_VERSION_KEY);
  return typeof stored[REMOTE_VERSION_KEY] === 'string'
    ? stored[REMOTE_VERSION_KEY]
    : null;
}
