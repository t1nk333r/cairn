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
  | {
      type: 'gitea:test-and-save';
      config: StoredGiteaConfig & { token: string };
    }
  | { type: 'gitea:get-config' }
  | { type: 'gitea:pull' }
  | { type: 'gitea:upload' }
  | {
      type: 'github:test-and-save';
      config: StoredGitHubConfig & { token: string };
    }
  | { type: 'github:get-config' }
  | { type: 'github:pull' }
  | { type: 'github:upload' };

export type HsyncResponse =
  | { ok: true; inventory: InventoryDocument | null }
  | { ok: true; webdavConfig: StoredWebDavConfig | null }
  | { ok: true; s3Config: StoredS3Config | null }
  | { ok: true; giteaConfig: StoredGiteaConfig | null }
  | { ok: true; githubConfig: StoredGitHubConfig | null }
  | { ok: true }
  | { ok: false; error: string };
