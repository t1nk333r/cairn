// One implementation of the pull/upload/upgrade/bookmark cycle, shared by every
// backend.
//
// The four services were byte-for-byte identical apart from the backend class,
// the config/version store, and their error wording — about 110 duplicated
// lines each. Every fix had to be made four times, and the 423-status and
// redirect bugs were both cases where it was made in fewer.
//
// What stays per-backend: `configureAndTest`, because each has its own
// normalize function and permission prompt, and the message strings, because
// users read them and "this S3 object" is not "this repository path".
import { BackendError, type InventoryBackend } from '../backends/contract';
import type { BookmarkDocument } from '../core/bookmarks';
import {
  INVENTORY_SCHEMA_VERSION,
  type DeviceObservation,
  type InventoryDocument,
} from '../core/inventory';
import { projectDeviceInventory } from '../core/inventory-projection';
import type { InventoryDocumentV2 } from '../core/inventory-v2';
import { saveBookmarksBaseline } from './bookmarks';
import { readBookmarkDocument, writeBookmarkDocument } from './bookmarks-sync';
import { getDeviceObservation } from './device';
import { loadInventory, saveComparisonBaseline } from './inventory-store';
import { readRemoteDocument, syncV2, upgradeRemoteToV2 } from './inventory-sync';

export interface UpgradeInventoryResult {
  inventory: InventoryDocument;
  /** false when the remote was already v2 and nothing was written. */
  upgraded: boolean;
}

export interface BackendServiceSpec<TConfig> {
  loadConfig(): Promise<TConfig | null>;
  createBackend(config: TConfig): InventoryBackend;
  /** Same config pointed at the sibling bookmark document. */
  bookmarksConfig(config: TConfig): TConfig;
  saveInventoryVersion(version: string): Promise<void>;
  loadBookmarksVersion(): Promise<string | null>;
  saveBookmarksVersion(version: string): Promise<void>;
  messages: {
    notConfigured: string;
    inventoryMissing: string;
    bookmarksMissing: string;
    scanBeforeUpload: string;
  };
}

export interface BackendService {
  pullInventory(): Promise<InventoryDocument>;
  uploadInventory(): Promise<InventoryDocument>;
  upgradeInventory(): Promise<UpgradeInventoryResult>;
  pullBookmarks(): Promise<BookmarkDocument>;
  backUpBookmarks(document: BookmarkDocument): Promise<BookmarkDocument>;
}

// A v2 document with no record for this device is the normal first-pull state
// of a device that has never synced, not corruption — project it as empty
// instead of letting `projectDeviceInventory` throw.
function projectForDevice(
  document: InventoryDocumentV2,
  device: DeviceObservation,
): InventoryDocument {
  if (document.devices[device.id] === undefined) {
    return {
      schemaVersion: INVENTORY_SCHEMA_VERSION,
      generatedAt: document.updatedAt,
      device,
      extensions: [],
    };
  }
  return projectDeviceInventory(document, device.id);
}

export function createBackendService<TConfig>(
  spec: BackendServiceSpec<TConfig>,
): BackendService {
  const requireConfig = async (): Promise<TConfig> => {
    const config = await spec.loadConfig();
    if (!config) throw new BackendError('invalid_config', spec.messages.notConfigured);
    return config;
  };

  const inventoryBackend = async () => spec.createBackend(await requireConfig());
  const bookmarksBackend = async () =>
    spec.createBackend(spec.bookmarksConfig(await requireConfig()));

  return {
    async pullInventory() {
      const shape = await readRemoteDocument(await inventoryBackend());
      if (shape.kind === 'absent') {
        throw new BackendError('not_found', spec.messages.inventoryMissing);
      }
      // A v1 remote stays legitimate until the user runs the upgrade action,
      // so single-device users keep working untouched.
      if (shape.kind === 'v1') {
        await Promise.all([
          saveComparisonBaseline(shape.document),
          spec.saveInventoryVersion(shape.version),
        ]);
        return shape.document;
      }
      const device = await getDeviceObservation();
      const inventory = projectForDevice(shape.document, device);
      // The baseline is stored projected so Compare keeps consuming the v1
      // shape it already understands.
      await Promise.all([
        saveComparisonBaseline(inventory),
        spec.saveInventoryVersion(shape.version),
      ]);
      return inventory;
    },

    async uploadInventory() {
      const backend = await inventoryBackend();
      const inventory = await loadInventory();
      if (!inventory) {
        throw new BackendError('not_found', spec.messages.scanBeforeUpload);
      }
      const device = await getDeviceObservation();
      // `syncV2` merges this device's observation into the remote union rather
      // than overwriting it, and handles versioning and conflict retries.
      const result = await syncV2({ backend, local: inventory });
      await spec.saveInventoryVersion(result.version);
      return projectForDevice(result.document, device);
    },

    async upgradeInventory() {
      const backend = await inventoryBackend();
      const device = await getDeviceObservation();
      const result = await upgradeRemoteToV2(backend);
      await spec.saveInventoryVersion(result.version);
      return {
        inventory: projectForDevice(result.document, device),
        upgraded: result.upgraded,
      };
    },

    async pullBookmarks() {
      const remote = await readBookmarkDocument(await bookmarksBackend());
      if (!remote) {
        throw new BackendError('not_found', spec.messages.bookmarksMissing);
      }
      await saveBookmarksBaseline(remote.document);
      await spec.saveBookmarksVersion(remote.version);
      return remote.document;
    },

    async backUpBookmarks(document: BookmarkDocument) {
      const result = await writeBookmarkDocument({
        backend: await bookmarksBackend(),
        document,
        expectedVersion: await spec.loadBookmarksVersion(),
      });
      await spec.saveBookmarksVersion(result.version);
      return document;
    },
  };
}
