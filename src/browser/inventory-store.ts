import type { InventoryDocument } from '../core/inventory';
import { isInventoryDocument } from '../core/inventory';

const INVENTORY_KEY = 'latestInventory';

export async function saveInventory(inventory: InventoryDocument): Promise<void> {
  await browser.storage.local.set({ [INVENTORY_KEY]: inventory });
}

export async function loadInventory(): Promise<InventoryDocument | null> {
  const stored = await browser.storage.local.get(INVENTORY_KEY);
  const value = stored[INVENTORY_KEY];
  return isInventoryDocument(value) ? value : null;
}

