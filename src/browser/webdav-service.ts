import { BackendError } from '../backends/contract';
import { WebDavBackend, normalizeWebDavConfig } from '../backends/webdav';
import {
  INVENTORY_SCHEMA_VERSION,
  type DeviceObservation,
  type InventoryDocument,
} from '../core/inventory';
import { projectDeviceInventory } from '../core/inventory-projection';
import type { InventoryDocumentV2 } from '../core/inventory-v2';
import { getDeviceObservation } from './device';
import { loadInventory, saveComparisonBaseline } from './inventory-store';
import {
  readRemoteDocument,
  syncV2,
  upgradeRemoteToV2,
} from './inventory-sync';
import type { BookmarkDocument } from '../core/bookmarks';
import { saveBookmarksBaseline } from './bookmarks';
import {
  bookmarksSibling,
  readBookmarkDocument,
  writeBookmarkDocument,
} from './bookmarks-sync';
import {
  loadWebDavConfig,
  saveWebDavConfig,
  saveWebDavRemoteVersion,
  loadWebDavBookmarksVersion,
  saveWebDavBookmarksVersion,
} from './webdav-store';

async function configuredBackend(): Promise<WebDavBackend> {
  const config = await loadWebDavConfig();
  if (!config) throw new BackendError('invalid_config', 'Configure WebDAV first.');
  return new WebDavBackend(config);
}

export async function configureAndTestWebDav(config: Parameters<typeof normalizeWebDavConfig>[0]) {
  const normalized = normalizeWebDavConfig(config);
  const backend = new WebDavBackend(normalized);
  await backend.testConnection();
  await saveWebDavConfig(normalized);
  return normalized;
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

export async function pullWebDavInventory() {
  const backend = await configuredBackend();
  const shape = await readRemoteDocument(backend);
  if (shape.kind === 'absent') {
    throw new BackendError('not_found', 'No hsync inventory exists at this WebDAV location yet.');
  }
  // A v1 remote is still legitimate until the user runs the upgrade action;
  // keep today's behavior exactly so single-device users keep working.
  if (shape.kind === 'v1') {
    await Promise.all([
      saveComparisonBaseline(shape.document),
      saveWebDavRemoteVersion(shape.version),
    ]);
    return shape.document;
  }
  const device = await getDeviceObservation();
  const inventory = projectForDevice(shape.document, device);
  // The baseline is stored projected so the options page's Compare view keeps
  // consuming the v1 shape it already understands.
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveWebDavRemoteVersion(shape.version),
  ]);
  return inventory;
}

export async function uploadWebDavInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before uploading.');

  const device = await getDeviceObservation();
  // `syncV2` merges this device's observation into the remote union instead
  // of overwriting the whole document, handling versioning and conflict
  // retries itself. The old `baseline && !knownVersion` pre-check guarded an
  // imported baseline against a whole-document overwrite; merging removes
  // that hazard, so the pre-check is gone.
  const result = await syncV2({ backend, local: inventory });
  await saveWebDavRemoteVersion(result.version);
  return projectForDevice(result.document, device);
}

export interface UpgradeInventoryResult {
  inventory: InventoryDocument;
  /** false when the remote was already v2 and nothing was written. */
  upgraded: boolean;
}

export async function upgradeWebDavInventory(): Promise<UpgradeInventoryResult> {
  const backend = await configuredBackend();
  const device = await getDeviceObservation();
  const result = await upgradeRemoteToV2(backend);
  await saveWebDavRemoteVersion(result.version);
  return {
    inventory: projectForDevice(result.document, device),
    upgraded: result.upgraded,
  };
}


// Bookmark backups live beside the inventory, in a sibling file derived from
// the configured path, so one connection covers both.
async function bookmarksBackend(): Promise<WebDavBackend> {
  const config = await loadWebDavConfig();
  if (!config) throw new BackendError('invalid_config', 'Configure WebDAV first.');
  return new WebDavBackend({ ...config, fileName: bookmarksSibling(config.fileName) });
}

export async function pullWebDavBookmarks(): Promise<BookmarkDocument> {
  const remote = await readBookmarkDocument(await bookmarksBackend());
  if (!remote) {
    throw new BackendError('not_found', 'No bookmark backup exists at this WebDAV location yet.');
  }
  await saveBookmarksBaseline(remote.document);
  await saveWebDavBookmarksVersion(remote.version);
  return remote.document;
}

export async function backUpWebDavBookmarks(
  document: BookmarkDocument,
): Promise<BookmarkDocument> {
  const backend = await bookmarksBackend();
  const result = await writeBookmarkDocument({
    backend,
    document,
    expectedVersion: await loadWebDavBookmarksVersion(),
  });
  await saveWebDavBookmarksVersion(result.version);
  return document;
}
