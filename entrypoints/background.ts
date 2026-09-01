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
  upgradeWebDavInventory,
  uploadWebDavInventory,
} from '../src/browser/webdav-service';
import { loadWebDavConfig } from '../src/browser/webdav-store';
import {
  configureAndTestS3,
  pullS3Inventory,
  upgradeS3Inventory,
  uploadS3Inventory,
} from '../src/browser/s3-service';
import { loadS3Config } from '../src/browser/s3-store';
import {
  configureAndTestGitea,
  pullGiteaInventory,
  upgradeGiteaInventory,
  uploadGiteaInventory,
} from '../src/browser/gitea-service';
import { loadGiteaConfig } from '../src/browser/gitea-store';
import {
  configureAndTestGitHub,
  pullGitHubInventory,
  upgradeGitHubInventory,
  uploadGitHubInventory,
} from '../src/browser/github-service';
import { loadGitHubConfig } from '../src/browser/github-store';

async function captureAndSave() {
  const inventory = await captureInventory({
    management: browser.management,
    device: await getDeviceObservation(),
  });
  await saveInventory(inventory);
  return inventory;
}

const CAPTURE_DEBOUNCE_MS = 750;

let captureTimer: ReturnType<typeof setTimeout> | null = null;
let captureInFlight: Promise<unknown> = Promise.resolve();

function scheduleCapture() {
  if (captureTimer !== null) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    captureInFlight = captureInFlight
      .then(() => captureAndSave())
      .catch((error: unknown) => {
        console.error('hsync: inventory capture failed', error);
      });
  }, CAPTURE_DEBOUNCE_MS);
}

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void captureAndSave();
  });

  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });

  browser.management.onInstalled.addListener(() => scheduleCapture());
  browser.management.onUninstalled.addListener(() => scheduleCapture());
  browser.management.onEnabled.addListener(() => scheduleCapture());
  browser.management.onDisabled.addListener(() => scheduleCapture());

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
      if (request.type === 'webdav:upgrade') {
        return upgradeWebDavInventory()
          .then(({ inventory, upgraded }) => ({ ok: true as const, inventory, upgraded }))
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
      if (request.type === 's3:upgrade') {
        return upgradeS3Inventory()
          .then(({ inventory, upgraded }) => ({ ok: true as const, inventory, upgraded }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'gitea:get-config') {
        return loadGiteaConfig()
          .then((config) => ({
            ok: true as const,
            giteaConfig: config
              ? {
                  baseUrl: config.baseUrl,
                  owner: config.owner,
                  repo: config.repo,
                  branch: config.branch,
                  filePath: config.filePath,
                }
              : null,
          }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'gitea:test-and-save') {
        return configureAndTestGitea(request.config)
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'gitea:pull') {
        return pullGiteaInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'gitea:upload') {
        return uploadGiteaInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'gitea:upgrade') {
        return upgradeGiteaInventory()
          .then(({ inventory, upgraded }) => ({ ok: true as const, inventory, upgraded }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'github:get-config') {
        return loadGitHubConfig()
          .then((config) => ({
            ok: true as const,
            githubConfig: config
              ? {
                  apiUrl: config.apiUrl,
                  owner: config.owner,
                  repo: config.repo,
                  branch: config.branch,
                  filePath: config.filePath,
                }
              : null,
          }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'github:test-and-save') {
        return configureAndTestGitHub(request.config)
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'github:pull') {
        return pullGitHubInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'github:upload') {
        return uploadGitHubInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      if (request.type === 'github:upgrade') {
        return upgradeGitHubInventory()
          .then(({ inventory, upgraded }) => ({ ok: true as const, inventory, upgraded }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      return undefined;
    },
  );
});
