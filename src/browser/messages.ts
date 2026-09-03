import type { BookmarkDocument, BookmarkPath } from '../core/bookmarks';
import type { BookmarkRootSummary, RestoreSummary } from './bookmarks';
import type {
  BackupRunRecord,
  StoredBackupSchedule,
} from './backup-schedule-store';
import type { InventoryDocument } from '../core/inventory';
import type { StoredWebDavConfig } from './webdav-store';
import type { StoredS3Config } from './s3-store';
import type { StoredGiteaConfig } from './gitea-store';
import type { StoredGitHubConfig } from './github-store';

export type HsyncRequest =
  | { type: 'inventory:capture' }
  | { type: 'inventory:get' }
  | { type: 'baseline:get' }
  | { type: 'baseline:set'; inventory: InventoryDocument }
  | { type: 'baseline:clear' }
  | {
      type: 'webdav:test-and-save';
      config: StoredWebDavConfig & { password: string };
    }
  | { type: 'webdav:get-config' }
  | { type: 'webdav:pull' }
  | { type: 'webdav:upload' }
  | { type: 'webdav:upgrade' }
  | {
      type: 's3:test-and-save';
      config: Omit<StoredS3Config, 'hasSessionToken'> & {
        secretAccessKey: string;
        sessionToken?: string;
      };
    }
  | { type: 's3:get-config' }
  | { type: 's3:pull' }
  | { type: 's3:upload' }
  | { type: 's3:upgrade' }
  | {
      type: 'gitea:test-and-save';
      config: StoredGiteaConfig & { token: string };
    }
  | { type: 'gitea:get-config' }
  | { type: 'gitea:pull' }
  | { type: 'gitea:upload' }
  | { type: 'gitea:upgrade' }
  | {
      type: 'github:test-and-save';
      config: StoredGitHubConfig & { token: string };
    }
  | { type: 'github:get-config' }
  | { type: 'github:pull' }
  | { type: 'github:upload' }
  | { type: 'github:upgrade' }
  | { type: 'bookmarks:capture' }
  | { type: 'bookmarks:get' }
  | { type: 'bookmarks:restore'; select?: readonly BookmarkPath[] | undefined }
  | { type: 'bookmarks:roots' }
  | { type: 'bookmarks:restore-source' }
  | { type: 'bookmarks:selection-get' }
  | { type: 'bookmarks:selection-set'; rootIds: readonly string[] }
  | { type: 'schedule:get' }
  | { type: 'schedule:set'; schedule: StoredBackupSchedule }
  | { type: 'schedule:run-now' }
  | { type: 'webdav:bookmarks-pull' }
  | { type: 'webdav:bookmarks-backup' }
  | { type: 's3:bookmarks-pull' }
  | { type: 's3:bookmarks-backup' }
  | { type: 'gitea:bookmarks-pull' }
  | { type: 'gitea:bookmarks-backup' }
  | { type: 'github:bookmarks-pull' }
  | { type: 'github:bookmarks-backup' };

export type HsyncResponse =
  | { ok: true; inventory: InventoryDocument | null }
  | { ok: true; bookmarks: BookmarkDocument | null }
  | { ok: true; restore: RestoreSummary }
  | { ok: true; inventory: InventoryDocument; upgraded: boolean }
  | { ok: true; webdavConfig: StoredWebDavConfig | null }
  | { ok: true; s3Config: StoredS3Config | null }
  | { ok: true; giteaConfig: StoredGiteaConfig | null }
  | { ok: true; githubConfig: StoredGitHubConfig | null }
  | { ok: true; roots: BookmarkRootSummary[] }
  | { ok: true; rootIds: string[] }
  | { ok: true; schedule: StoredBackupSchedule; lastRun: BackupRunRecord | null }
  | { ok: true; run: BackupRunRecord }
  | { ok: true }
  | { ok: false; error: string };
