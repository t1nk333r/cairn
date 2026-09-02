import { WebDavBackend, normalizeWebDavConfig, type WebDavConfig } from '../backends/webdav';
import { bookmarksSibling } from './bookmarks-sync';
import { createBackendService } from './backend-service';
import {
  loadWebDavBookmarksVersion,
  loadWebDavConfig,
  saveWebDavBookmarksVersion,
  saveWebDavConfig,
  saveWebDavRemoteVersion,
} from './webdav-store';

export type { UpgradeInventoryResult } from './backend-service';

export async function configureAndTestWebDav(config: Parameters<typeof normalizeWebDavConfig>[0]) {
  const normalized = normalizeWebDavConfig(config);
  const backend = new WebDavBackend(normalized);
  await backend.testConnection();
  await saveWebDavConfig(normalized);
  return normalized;
}

const service = createBackendService<WebDavConfig>({
  loadConfig: loadWebDavConfig,
  createBackend: (config) => new WebDavBackend(config),
  bookmarksConfig: (config) => ({
    ...config,
    fileName: bookmarksSibling(config.fileName),
  }),
  saveInventoryVersion: saveWebDavRemoteVersion,
  loadBookmarksVersion: loadWebDavBookmarksVersion,
  saveBookmarksVersion: saveWebDavBookmarksVersion,
  messages: {
    notConfigured: 'Configure WebDAV first.',
    inventoryMissing: 'No Cairn inventory exists at this WebDAV location yet.',
    bookmarksMissing: 'No bookmark backup exists at this WebDAV location yet.',
    scanBeforeUpload: 'Scan local extensions before uploading.',
  },
});

export const pullWebDavInventory = service.pullInventory;
export const uploadWebDavInventory = service.uploadInventory;
export const upgradeWebDavInventory = service.upgradeInventory;
export const pullWebDavBookmarks = service.pullBookmarks;
export const backUpWebDavBookmarks = service.backUpBookmarks;
