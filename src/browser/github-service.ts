import { GitHubBackend, normalizeGitHubConfig, type GitHubConfig } from '../backends/github';
import { bookmarksSibling } from './bookmarks-sync';
import { createBackendService } from './backend-service';
import {
  loadGitHubBookmarksVersion,
  loadGitHubConfig,
  saveGitHubBookmarksVersion,
  saveGitHubConfig,
  saveGitHubRemoteVersion,
} from './github-store';

export type { UpgradeInventoryResult } from './backend-service';

export async function configureAndTestGitHub(config: Parameters<typeof normalizeGitHubConfig>[0]) {
  const normalized = normalizeGitHubConfig(config);
  const backend = new GitHubBackend(normalized);
  await backend.testConnection();
  await saveGitHubConfig(normalized);
  return normalized;
}

const service = createBackendService<GitHubConfig>({
  loadConfig: loadGitHubConfig,
  createBackend: (config) => new GitHubBackend(config),
  bookmarksConfig: (config) => ({
    ...config,
    filePath: bookmarksSibling(config.filePath),
  }),
  saveInventoryVersion: saveGitHubRemoteVersion,
  loadBookmarksVersion: loadGitHubBookmarksVersion,
  saveBookmarksVersion: saveGitHubBookmarksVersion,
  messages: {
    notConfigured: 'Configure GitHub first.',
    inventoryMissing: 'No Cairn inventory exists at this Git path yet.',
    bookmarksMissing: 'No bookmark backup exists at this Git path yet.',
    scanBeforeUpload: 'Scan local extensions before committing.',
  },
});

export const pullGitHubInventory = service.pullInventory;
export const uploadGitHubInventory = service.uploadInventory;
export const upgradeGitHubInventory = service.upgradeInventory;
export const pullGitHubBookmarks = service.pullBookmarks;
export const backUpGitHubBookmarks = service.backUpBookmarks;
