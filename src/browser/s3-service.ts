import { S3Backend, normalizeS3Config, type S3Config } from '../backends/s3';
import { bookmarksSibling } from './bookmarks-sync';
import { createBackendService } from './backend-service';
import {
  loadS3BookmarksVersion,
  loadS3Config,
  saveS3BookmarksVersion,
  saveS3Config,
  saveS3RemoteVersion,
} from './s3-store';

export type { UpgradeInventoryResult } from './backend-service';

export async function configureAndTestS3(config: Parameters<typeof normalizeS3Config>[0]) {
  const normalized = normalizeS3Config(config);
  const backend = new S3Backend(normalized);
  await backend.testConnection();
  await saveS3Config(normalized);
  return normalized;
}

const service = createBackendService<S3Config>({
  loadConfig: loadS3Config,
  createBackend: (config) => new S3Backend(config),
  bookmarksConfig: (config) => ({
    ...config,
    objectKey: bookmarksSibling(config.objectKey),
  }),
  saveInventoryVersion: saveS3RemoteVersion,
  loadBookmarksVersion: loadS3BookmarksVersion,
  saveBookmarksVersion: saveS3BookmarksVersion,
  messages: {
    notConfigured: 'Configure S3 first.',
    inventoryMissing: 'No Cairn inventory exists at this S3 object yet.',
    bookmarksMissing: 'No bookmark backup exists at this S3 location yet.',
    scanBeforeUpload: 'Scan local extensions before uploading.',
  },
});

export const pullS3Inventory = service.pullInventory;
export const uploadS3Inventory = service.uploadInventory;
export const upgradeS3Inventory = service.upgradeInventory;
export const pullS3Bookmarks = service.pullBookmarks;
export const backUpS3Bookmarks = service.backUpBookmarks;
