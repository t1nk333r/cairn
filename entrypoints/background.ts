import { getDeviceObservation } from '../src/browser/device';
import {
  clearComparisonBaseline,
  loadComparisonBaseline,
  loadInventory,
  saveComparisonBaseline,
  saveInventory,
} from '../src/browser/inventory-store';
import type { HsyncRequest, HsyncResponse } from '../src/browser/messages';
import { captureInventory } from '../src/core/inventory';
import {
  configureAndTestWebDav,
  pullWebDavInventory,
  uploadWebDavInventory,
} from '../src/browser/webdav-service';
import { loadWebDavConfig } from '../src/browser/webdav-store';

async function captureAndSave() {
  const inventory = await captureInventory({
    management: browser.management,
    device: await getDeviceObservation(),
  });
  await saveInventory(inventory);
  return inventory;
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void captureAndSave();
  });

  browser.management.onInstalled.addListener(() => void captureAndSave());
  browser.management.onUninstalled.addListener(() => void captureAndSave());
  browser.management.onEnabled.addListener(() => void captureAndSave());
  browser.management.onDisabled.addListener(() => void captureAndSave());

  browser.runtime.onMessage.addListener(
    (request: HsyncRequest): Promise<HsyncResponse> | undefined => {
      if (request.type === 'inventory:capture') {
        return captureAndSave()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'inventory:get') {
        return loadInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'baseline:get') {
        return loadComparisonBaseline()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'baseline:set') {
        return saveComparisonBaseline(request.inventory)
          .then(() => ({ ok: true as const, inventory: request.inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'baseline:clear') {
        return clearComparisonBaseline()
          .then(() => ({ ok: true as const, inventory: null }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'webdav:get-config') {
        return loadWebDavConfig()
          .then((config) => ({
            ok: true as const,
            webdavConfig: config
              ? {
                  baseUrl: config.baseUrl,
                  fileName: config.fileName,
                  username: config.username,
                }
              : null,
          }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'webdav:test-and-save') {
        return configureAndTestWebDav(request.config)
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'webdav:pull') {
        return pullWebDavInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'webdav:upload') {
        return uploadWebDavInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'options:open') {
        return browser.runtime
          .openOptionsPage()
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      return undefined;
    },
  );
});
