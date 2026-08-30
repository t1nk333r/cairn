import type { NativeGitConfig } from '../native/protocol';

const CONFIG_KEY = 'nativeGitConfig';
const VERSION_KEY = 'nativeGitRemoteVersion';
const CREDENTIAL_MARKER_KEY = 'nativeGitCredentialStored';

export async function saveNativeGitConfig(config: NativeGitConfig): Promise<void> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  const previous = stored[CONFIG_KEY] as NativeGitConfig | undefined;
  const changed = !previous || Object.entries(config).some(
    ([key, value]) => previous[key as keyof NativeGitConfig] !== value,
  );
  await browser.storage.local.set({ [CONFIG_KEY]: config });
  if (changed) await browser.storage.local.remove([VERSION_KEY, CREDENTIAL_MARKER_KEY]);
}

export async function saveNativeGitCredentialMarker(stored: boolean): Promise<void> {
  if (stored) {
    await browser.storage.local.set({ [CREDENTIAL_MARKER_KEY]: true });
  } else {
    await browser.storage.local.remove(CREDENTIAL_MARKER_KEY);
  }
}

export async function loadNativeGitCredentialMarker(): Promise<boolean> {
  const stored = await browser.storage.local.get(CREDENTIAL_MARKER_KEY);
  return stored[CREDENTIAL_MARKER_KEY] === true;
}

export async function loadNativeGitConfig(): Promise<NativeGitConfig | null> {
  const stored = await browser.storage.local.get(CONFIG_KEY);
  const config = stored[CONFIG_KEY];
  if (!config || typeof config !== 'object') return null;
  return config as NativeGitConfig;
}

export async function saveNativeGitRemoteVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [VERSION_KEY]: version });
}

export async function loadNativeGitRemoteVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(VERSION_KEY);
  return typeof stored[VERSION_KEY] === 'string' ? stored[VERSION_KEY] : null;
}
