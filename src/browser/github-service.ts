import { BackendError } from '../backends/contract';
import { GitHubBackend, normalizeGitHubConfig, type GitHubConfig } from '../backends/github';
import {
  INVENTORY_SCHEMA_VERSION,
  type DeviceObservation,
  type InventoryDocument,
} from '../core/inventory';
import { projectDeviceInventory } from '../core/inventory-projection';
import type { InventoryDocumentV2 } from '../core/inventory-v2';
import { getDeviceObservation } from './device';
import {
  loadGitHubConfig,
  saveGitHubConfig,
  saveGitHubRemoteVersion,
  loadGitHubBookmarksVersion,
  saveGitHubBookmarksVersion,
} from './github-store';
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

async function configuredBackend(): Promise<GitHubBackend> {
  const config = await loadGitHubConfig();
  if (!config) throw new BackendError('invalid_config', 'Configure GitHub first.');
  return new GitHubBackend(config);
}

export async function configureAndTestGitHub(config: GitHubConfig) {
  const normalized = normalizeGitHubConfig(config);
  const backend = new GitHubBackend(normalized);
  await backend.testConnection();
  await saveGitHubConfig(normalized);
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

export async function pullGitHubInventory() {
  const backend = await configuredBackend();
  const shape = await readRemoteDocument(backend);
  if (shape.kind === 'absent') {
    throw new BackendError('not_found', 'No hsync inventory exists at this Git path yet.');
  }
  // A v1 remote is still legitimate until the user runs the upgrade action;
  // keep today's behavior exactly so single-device users keep working.
  if (shape.kind === 'v1') {
    await Promise.all([
      saveComparisonBaseline(shape.document),
      saveGitHubRemoteVersion(shape.version),
    ]);
    return shape.document;
  }
  const device = await getDeviceObservation();
  const inventory = projectForDevice(shape.document, device);
  // The baseline is stored projected so the options page's Compare view keeps
  // consuming the v1 shape it already understands.
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveGitHubRemoteVersion(shape.version),
  ]);
  return inventory;
}

export async function uploadGitHubInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before committing.');

  const device = await getDeviceObservation();
  // `syncV2` merges this device's observation into the remote union instead
  // of overwriting the whole document, handling versioning and conflict
  // retries itself. The old `baseline && !knownVersion` pre-check guarded an
  // imported baseline against a whole-document overwrite; merging removes
  // that hazard, so the pre-check is gone.
  const result = await syncV2({ backend, local: inventory });
  await saveGitHubRemoteVersion(result.version);
  return projectForDevice(result.document, device);
}

export interface UpgradeInventoryResult {
  inventory: InventoryDocument;
  /** false when the remote was already v2 and nothing was written. */
  upgraded: boolean;
}

export async function upgradeGitHubInventory(): Promise<UpgradeInventoryResult> {
  const backend = await configuredBackend();
  const device = await getDeviceObservation();
  const result = await upgradeRemoteToV2(backend);
  await saveGitHubRemoteVersion(result.version);
  return {
    inventory: projectForDevice(result.document, device),
    upgraded: result.upgraded,
  };
}


// Bookmark backups live beside the inventory, in a sibling file derived from
// the configured path, so one connection covers both.
async function bookmarksBackend(): Promise<GitHubBackend> {
  const config = await loadGitHubConfig();
  if (!config) throw new BackendError('invalid_config', 'Configure GitHub first.');
  return new GitHubBackend({ ...config, filePath: bookmarksSibling(config.filePath) });
}

export async function pullGitHubBookmarks(): Promise<BookmarkDocument> {
  const remote = await readBookmarkDocument(await bookmarksBackend());
  if (!remote) {
    throw new BackendError('not_found', 'No bookmark backup exists at this Git path yet.');
  }
  await saveBookmarksBaseline(remote.document);
  await saveGitHubBookmarksVersion(remote.version);
  return remote.document;
}

export async function backUpGitHubBookmarks(
  document: BookmarkDocument,
): Promise<BookmarkDocument> {
  const backend = await bookmarksBackend();
  const result = await writeBookmarkDocument({
    backend,
    document,
    expectedVersion: await loadGitHubBookmarksVersion(),
  });
  await saveGitHubBookmarksVersion(result.version);
  return document;
}
