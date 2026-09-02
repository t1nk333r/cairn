import { GiteaBackend, normalizeGiteaConfig, type GiteaConfig } from '../backends/gitea';
import { bookmarksSibling } from './bookmarks-sync';
import { createBackendService } from './backend-service';
import {
  loadGiteaBookmarksVersion,
  loadGiteaConfig,
  saveGiteaBookmarksVersion,
  saveGiteaConfig,
  saveGiteaRemoteVersion,
} from './gitea-store';

export type { UpgradeInventoryResult } from './backend-service';

export async function configureAndTestGitea(config: Parameters<typeof normalizeGiteaConfig>[0]) {
  const normalized = normalizeGiteaConfig(config);
  const backend = new GiteaBackend(normalized);
  await backend.testConnection();
  await saveGiteaConfig(normalized);
  return normalized;
}

const service = createBackendService<GiteaConfig>({
  loadConfig: loadGiteaConfig,
  createBackend: (config) => new GiteaBackend(config),
  bookmarksConfig: (config) => ({
    ...config,
    filePath: bookmarksSibling(config.filePath),
  }),
  saveInventoryVersion: saveGiteaRemoteVersion,
  loadBookmarksVersion: loadGiteaBookmarksVersion,
  saveBookmarksVersion: saveGiteaBookmarksVersion,
  messages: {
    notConfigured: 'Configure Gitea first.',
    inventoryMissing: 'No Cairn inventory exists at this repository path yet.',
    bookmarksMissing: 'No bookmark backup exists at this repository path yet.',
    scanBeforeUpload: 'Scan local extensions before uploading.',
  },
});

export const pullGiteaInventory = service.pullInventory;
export const uploadGiteaInventory = service.uploadInventory;
export const upgradeGiteaInventory = service.upgradeInventory;
export const pullGiteaBookmarks = service.pullBookmarks;
export const backUpGiteaBookmarks = service.backUpBookmarks;
