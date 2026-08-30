import { BackendError } from '../backends/contract';
import { normalizeS3Config, S3Backend, type S3Config } from '../backends/s3';
import { parseInventoryJson, serializeInventory } from '../core/inventory';
import {
  loadComparisonBaseline,
  loadInventory,
  saveComparisonBaseline,
} from './inventory-store';
import {
  loadS3Config,
  loadS3RemoteVersion,
  saveS3Config,
  saveS3RemoteVersion,
} from './s3-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export async function pullS3Inventory() {
  const backend = await configuredBackend();
  const remote = await backend.read();
  if (!remote) {
    throw new BackendError('not_found', 'No hsync inventory exists at this S3 object yet.');
  }
  const inventory = parseInventoryJson(decoder.decode(remote.data));
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveS3RemoteVersion(remote.version),
  ]);
  return inventory;
}

export async function uploadS3Inventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before uploading.');
  const [knownVersion, baseline] = await Promise.all([
    loadS3RemoteVersion(),
    loadComparisonBaseline(),
  ]);
  if (baseline && !knownVersion) {
    throw new BackendError(
      'conflict',
      'Pull the S3 inventory before replacing an imported comparison baseline.',
    );
  }
  const result = await backend.write({
    data: encoder.encode(serializeInventory(inventory)),
    expectedVersion: knownVersion,
  });
  await saveS3RemoteVersion(result.version);
  return inventory;
}

