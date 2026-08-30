import type { InventoryDocument } from '../core/inventory';

export type HsyncRequest =
  | { type: 'inventory:capture' }
  | { type: 'inventory:get' }
  | { type: 'baseline:get' }
  | { type: 'baseline:set'; inventory: InventoryDocument }
  | { type: 'baseline:clear' }
  | { type: 'options:open' };

export type HsyncResponse =
  | { ok: true; inventory: InventoryDocument | null }
  | { ok: true }
  | { ok: false; error: string };
