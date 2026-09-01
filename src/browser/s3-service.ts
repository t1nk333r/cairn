import { BackendError } from '../backends/contract';
import { normalizeS3Config, S3Backend, type S3Config } from '../backends/s3';
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
import {
  loadS3Config,
  saveS3Config,
  saveS3RemoteVersion,
} from './s3-store';

async function configuredBackend(): Promise<S3Backend> {
  const config = await loadS3Config();
  if (!config) throw new BackendError('invalid_config', 'Configure S3 first.');
  return new S3Backend(config);
}

export async function configureAndTestS3(config: S3Config) {
  const normalized = normalizeS3Config(config);
  const backend = new S3Backend(normalized);
  await backend.testConnection();
  await saveS3Config(normalized);
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

export async function pullS3Inventory() {
  const backend = await configuredBackend();
  const shape = await readRemoteDocument(backend);
  if (shape.kind === 'absent') {
    throw new BackendError('not_found', 'No hsync inventory exists at this S3 object yet.');
  }
  // A v1 remote is still legitimate until the user runs the upgrade action;
  // keep today's behavior exactly so single-device users keep working.
  if (shape.kind === 'v1') {
    await Promise.all([
      saveComparisonBaseline(shape.document),
      saveS3RemoteVersion(shape.version),
    ]);
    return shape.document;
  }
  const device = await getDeviceObservation();
  const inventory = projectForDevice(shape.document, device);
  // The baseline is stored projected so the options page's Compare view keeps
  // consuming the v1 shape it already understands.
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveS3RemoteVersion(shape.version),
  ]);
  return inventory;
}

export async function uploadS3Inventory() {
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
  await saveS3RemoteVersion(result.version);
  return projectForDevice(result.document, device);
}

export interface UpgradeInventoryResult {
  inventory: InventoryDocument;
  /** false when the remote was already v2 and nothing was written. */
  upgraded: boolean;
}

export async function upgradeS3Inventory(): Promise<UpgradeInventoryResult> {
  const backend = await configuredBackend();
  const device = await getDeviceObservation();
  const result = await upgradeRemoteToV2(backend);
  await saveS3RemoteVersion(result.version);
  return {
    inventory: projectForDevice(result.document, device),
    upgraded: result.upgraded,
  };
}
