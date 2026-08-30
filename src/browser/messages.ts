import type { InventoryDocument } from '../core/inventory';
import type { StoredWebDavConfig } from './webdav-store';

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
  | { type: 'options:open' };

export type HsyncResponse =
  | { ok: true; inventory: InventoryDocument | null }
  | { ok: true; webdavConfig: StoredWebDavConfig | null }
  | { ok: true }
  | { ok: false; error: string };
