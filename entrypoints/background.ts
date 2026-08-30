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
import {
  configureAndTestS3,
  pullS3Inventory,
  uploadS3Inventory,
} from '../src/browser/s3-service';
import { loadS3Config } from '../src/browser/s3-store';

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
      if (request.type === 's3:get-config') {
        return loadS3Config()
          .then((config) => ({
            ok: true as const,
            s3Config: config
              ? {
                  endpoint: config.endpoint,
                  region: config.region,
                  bucket: config.bucket,
                  objectKey: config.objectKey,
                  forcePathStyle: config.forcePathStyle,
                  accessKeyId: config.accessKeyId,
                  hasSessionToken: !!config.sessionToken,
                }
              : null,
          }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 's3:test-and-save') {
        return configureAndTestS3(request.config)
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 's3:pull') {
        return pullS3Inventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 's3:upload') {
        return uploadS3Inventory()
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
