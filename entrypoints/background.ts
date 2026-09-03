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
  listBookmarkRoots,
  loadBookmarks,
  loadBookmarksBaseline,
  restoreBookmarks,
  saveBookmarks,
} from '../src/browser/bookmarks';
import {
  applyBackupSchedule,
  BACKUP_ALARM_NAME,
  runScheduledBackup,
  type AlarmsApi,
} from '../src/browser/backup-schedule';
import type { BackupRunRecord, BackupTarget } from '../src/browser/backup-schedule-store';
import {
  loadBackupRun,
  loadBackupSchedule,
  loadIncludedRootIds,
  saveBackupRun,
  saveBackupSchedule,
  saveIncludedRootIds,
} from '../src/browser/backup-schedule-store';
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
 * Captures the tree the user actually chose to sync.
 *
 * The root filter is read here rather than passed in by the caller so every
 * path — manual scan, scheduled backup — honours the same selection. A folder
 * excluded from the backup must not reach a shared repository just because a
 * different code path did the capturing.
 */
async function captureSelectedBookmarks(): Promise<BookmarkDocument> {
  return captureLocalBookmarks({
    api: browser.bookmarks,
    device: await getDeviceObservation(),
    includeRootIds: await loadIncludedRootIds(),
  });
}

const BOOKMARK_BACKUP_WRITERS: Record<
  BackupTarget,
  (document: BookmarkDocument) => Promise<unknown>
> = {
  webdav: backUpWebDavBookmarks,
  s3: backUpS3Bookmarks,
  gitea: backUpGiteaBookmarks,
  github: backUpGitHubBookmarks,
};

/**
 * One scheduled backup: capture, write, record the outcome.
 *
 * The record is the only feedback channel an alarm has. Nothing is listening
 * when it fires, so a failed token or a revoked host permission would
 * otherwise be invisible and the user would assume backups are running.
 */
async function runBackupCycle(): Promise<BackupRunRecord> {
  const schedule = await loadBackupSchedule();
  const record = await runScheduledBackup({
    schedule,
    capture: async () => {
      const document = await captureSelectedBookmarks();
      await saveBookmarks(document);
      return document;
    },
    backUp: (target, document) => BOOKMARK_BACKUP_WRITERS[target](document),
  });
  await saveBackupRun(record);
  if (!record.ok) console.error('cairn: scheduled bookmark backup failed', record.error);
  return record;
}

// `browser.alarms.create` is declared with four overloads, and TypeScript will
// not match that against the narrow injectable shape the schedule module takes.
// Adapting here keeps the module free of extension typings and testable with a
// plain object.
const ALARMS: AlarmsApi = {
  create: (name, info) => browser.alarms.create(name, info),
  clear: (name) => browser.alarms.clear(name),
};

async function reapplyStoredSchedule(): Promise<void> {
  try {
    await applyBackupSchedule(ALARMS, await loadBackupSchedule());
  } catch (error: unknown) {
    console.error('cairn: could not register the backup alarm', error);
  }
}

/**
 * The document a restore would actually recreate.
 *
 * Exposed to the options page as its own request so the selection tree it
 * renders is addressing the same document this worker will restore. Index
 * paths computed against a different tree would silently restore the wrong
 * nodes, and duplicating the "pulled wins" rule in the page is how the two
 * drift apart.
 */
async function resolveRestoreDocument(): Promise<BookmarkDocument | null> {
  return (await loadBookmarksBaseline()) ?? (await loadBookmarks());
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
    const bookmarks = await captureSelectedBookmarks();
    await saveBookmarks(bookmarks);
    return { ok: true, bookmarks };
  },
  'bookmarks:get': async () => ({ ok: true, bookmarks: await loadBookmarks() }),
  'bookmarks:restore': async (request) => {
    const document = await resolveRestoreDocument();
    if (!document) throw new Error('Pull or scan a bookmark backup before restoring.');
    return {
      ok: true,
      restore: await restoreBookmarks({
        api: browser.bookmarks,
        document,
        // Absent means the whole document, which is what the plain restore
        // button sends.
        select: request.select,
      }),
    };
  },
  'bookmarks:roots': async () => ({
    ok: true,
    roots: await listBookmarkRoots(browser.bookmarks),
  }),
  'bookmarks:restore-source': async () => ({ ok: true, bookmarks: await resolveRestoreDocument() }),
  'bookmarks:selection-get': async () => ({ ok: true, rootIds: await loadIncludedRootIds() }),
  'bookmarks:selection-set': async (request) => {
    await saveIncludedRootIds(request.rootIds);
    return { ok: true, rootIds: await loadIncludedRootIds() };
  },

  'schedule:get': async () => ({
    ok: true,
    schedule: await loadBackupSchedule(),
    lastRun: await loadBackupRun(),
  }),
  'schedule:set': async (request) => {
    await saveBackupSchedule(request.schedule);
    const schedule = await loadBackupSchedule();
    // Re-register immediately: a schedule the user just switched on must not
    // wait for the next browser start to exist.
    await applyBackupSchedule(ALARMS, schedule);
    return { ok: true, schedule, lastRun: await loadBackupRun() };
  },
  'schedule:run-now': async () => ({ ok: true, run: await runBackupCycle() }),

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
    // An update clears registered alarms, so the schedule has to be re-applied
    // from storage or automatic backups stop silently after every upgrade.
    void reapplyStoredSchedule();
  });

  browser.runtime.onStartup.addListener(() => {
    void reapplyStoredSchedule();
  });

  browser.alarms.onAlarm.addListener((alarm: { name: string }) => {
    if (alarm.name !== BACKUP_ALARM_NAME) return;
    void runBackupCycle();
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
