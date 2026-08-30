import type { InventoryDocument } from '../core/inventory';
import { isInventoryDocument } from '../core/inventory';

const INVENTORY_KEY = 'latestInventory';
const COMPARISON_BASELINE_KEY = 'comparisonBaseline';

export async function saveInventory(inventory: InventoryDocument): Promise<void> {
  await browser.storage.local.set({ [INVENTORY_KEY]: inventory });
}

export async function loadInventory(): Promise<InventoryDocument | null> {
  const stored = await browser.storage.local.get(INVENTORY_KEY);
  const value = stored[INVENTORY_KEY];
  return isInventoryDocument(value) ? value : null;
}

export async function saveComparisonBaseline(
  inventory: InventoryDocument,
): Promise<void> {
  await browser.storage.local.set({ [COMPARISON_BASELINE_KEY]: inventory });
}

export async function loadComparisonBaseline(): Promise<InventoryDocument | null> {
  const stored = await browser.storage.local.get(COMPARISON_BASELINE_KEY);
  const value = stored[COMPARISON_BASELINE_KEY];
  return isInventoryDocument(value) ? value : null;
}

export async function clearComparisonBaseline(): Promise<void> {
  await browser.storage.local.remove(COMPARISON_BASELINE_KEY);
}
