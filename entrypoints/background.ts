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
import type { BookmarkDocument } from '../src/core/bookmarks';
import {
  captureLocalBookmarks,
  loadBookmarks,
  loadBookmarksBaseline,
  restoreBookmarks,
  saveBookmarks,
} from '../src/browser/bookmarks';
import {
  configureAndTestWebDav,
  pullWebDavInventory,
  upgradeWebDavInventory,
  uploadWebDavInventory,
  pullWebDavBookmarks,
  backUpWebDavBookmarks,
} from '../src/browser/webdav-service';
import { loadWebDavConfig } from '../src/browser/webdav-store';
import {
  configureAndTestS3,
  pullS3Inventory,
  upgradeS3Inventory,
  uploadS3Inventory,
  pullS3Bookmarks,
  backUpS3Bookmarks,
} from '../src/browser/s3-service';
import { loadS3Config } from '../src/browser/s3-store';
import {
  configureAndTestGitea,
  pullGiteaInventory,
  upgradeGiteaInventory,
  uploadGiteaInventory,
  pullGiteaBookmarks,
  backUpGiteaBookmarks,
} from '../src/browser/gitea-service';
import { loadGiteaConfig } from '../src/browser/gitea-store';
import {
  configureAndTestGitHub,
  pullGitHubInventory,
  upgradeGitHubInventory,
  uploadGitHubInventory,
  pullGitHubBookmarks,
  backUpGitHubBookmarks,
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
        console.error('cairn: inventory capture failed', error);
      });
  }, CAPTURE_DEBOUNCE_MS);
}

async function backUpStoredBookmarks(
  write: (document: BookmarkDocument) => Promise<unknown>,
): Promise<HsyncResponse> {
  const bookmarks = await loadBookmarks();
  if (!bookmarks) throw new Error('Scan bookmarks before backing them up.');
  await write(bookmarks);
  return { ok: true, bookmarks };
}

/**
 * One handler per request type, keyed by that type.
 *
 * The mapped type is the point: adding a member to `HsyncRequest` without a
 * handler here is a compile error, where the previous chain of 36
 * `if (request.type === …)` blocks would simply fall through and return
 * `undefined`, leaving the options page waiting on a reply that never came.
 * Each handler resolves the success shape; the listener adds the shared error
 * wrapper, which every one of those 36 blocks used to repeat verbatim.
 */
const handlers: {
  [K in HsyncRequest['type']]: (
    request: Extract<HsyncRequest, { type: K }>,
  ) => Promise<HsyncResponse>;
} = {
  'inventory:capture': async () => ({ ok: true, inventory: await captureAndSave() }),
  'inventory:get': async () => ({ ok: true, inventory: await loadInventory() }),
  'baseline:get': async () => ({ ok: true, inventory: await loadComparisonBaseline() }),
  'baseline:set': async (request) => {
    await saveComparisonBaseline(request.inventory);
    return { ok: true, inventory: request.inventory };
  },
  'baseline:clear': async () => {
    await clearComparisonBaseline();
    return { ok: true };
  },

  'bookmarks:capture': async () => {
    const bookmarks = await captureLocalBookmarks({
      api: browser.bookmarks,
      device: await getDeviceObservation(),
    });
    await saveBookmarks(bookmarks);
    return { ok: true, bookmarks };
  },
  'bookmarks:get': async () => ({ ok: true, bookmarks: await loadBookmarks() }),
  'bookmarks:restore': async () => {
    // Prefer the pulled remote backup, so restore uses what the user just
    // compared against rather than a stale local capture.
    const document = (await loadBookmarksBaseline()) ?? (await loadBookmarks());
    if (!document) throw new Error('Pull or scan a bookmark backup before restoring.');
    return {
      ok: true,
      restore: await restoreBookmarks({ api: browser.bookmarks, document }),
    };
  },

  'webdav:get-config': async () => {
    const config = await loadWebDavConfig();
    return {
      ok: true,
      webdavConfig: config
        ? { baseUrl: config.baseUrl, fileName: config.fileName, username: config.username }
        : null,
    };
  },
  'webdav:test-and-save': async (request) => {
    await configureAndTestWebDav(request.config);
    return { ok: true };
  },
  'webdav:pull': async () => ({ ok: true, inventory: await pullWebDavInventory() }),
  'webdav:upload': async () => ({ ok: true, inventory: await uploadWebDavInventory() }),
  'webdav:upgrade': async () => ({ ok: true, ...(await upgradeWebDavInventory()) }),
  'webdav:bookmarks-pull': async () => ({ ok: true, bookmarks: await pullWebDavBookmarks() }),
  'webdav:bookmarks-backup': async () => backUpStoredBookmarks(backUpWebDavBookmarks),

  's3:get-config': async () => {
    const config = await loadS3Config();
    return {
      ok: true,
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
    };
  },
  's3:test-and-save': async (request) => {
    await configureAndTestS3(request.config);
    return { ok: true };
  },
  's3:upgrade': async () => ({ ok: true, ...(await upgradeS3Inventory()) }),
  's3:pull': async () => ({ ok: true, inventory: await pullS3Inventory() }),
  's3:upload': async () => ({ ok: true, inventory: await uploadS3Inventory() }),
  's3:bookmarks-pull': async () => ({ ok: true, bookmarks: await pullS3Bookmarks() }),
  's3:bookmarks-backup': async () => backUpStoredBookmarks(backUpS3Bookmarks),

  'gitea:get-config': async () => {
    const config = await loadGiteaConfig();
    return {
      ok: true,
      giteaConfig: config
        ? {
            baseUrl: config.baseUrl,
            owner: config.owner,
            repo: config.repo,
            branch: config.branch,
            filePath: config.filePath,
          }
        : null,
    };
  },
  'gitea:test-and-save': async (request) => {
    await configureAndTestGitea(request.config);
    return { ok: true };
  },
  'gitea:pull': async () => ({ ok: true, inventory: await pullGiteaInventory() }),
  'gitea:upload': async () => ({ ok: true, inventory: await uploadGiteaInventory() }),
  'gitea:upgrade': async () => ({ ok: true, ...(await upgradeGiteaInventory()) }),
  'gitea:bookmarks-pull': async () => ({ ok: true, bookmarks: await pullGiteaBookmarks() }),
  'gitea:bookmarks-backup': async () => backUpStoredBookmarks(backUpGiteaBookmarks),

  'github:get-config': async () => {
    const config = await loadGitHubConfig();
    return {
      ok: true,
      githubConfig: config
        ? {
            apiUrl: config.apiUrl,
            owner: config.owner,
            repo: config.repo,
            branch: config.branch,
            filePath: config.filePath,
          }
        : null,
    };
  },
  'github:test-and-save': async (request) => {
    await configureAndTestGitHub(request.config);
    return { ok: true };
  },
  'github:pull': async () => ({ ok: true, inventory: await pullGitHubInventory() }),
  'github:upload': async () => ({ ok: true, inventory: await uploadGitHubInventory() }),
  'github:upgrade': async () => ({ ok: true, ...(await upgradeGitHubInventory()) }),
  'github:bookmarks-pull': async () => ({ ok: true, bookmarks: await pullGitHubBookmarks() }),
  'github:bookmarks-backup': async () => backUpStoredBookmarks(backUpGitHubBookmarks),
};

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
      const handler = handlers[request.type];
      if (!handler) return undefined;
      return (handler as (input: HsyncRequest) => Promise<HsyncResponse>)(request).catch(
        (error: unknown) => ({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  );
});
