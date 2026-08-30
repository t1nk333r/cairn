import { BackendError } from '../backends/contract';
import { WebDavBackend, normalizeWebDavConfig } from '../backends/webdav';
import { parseInventoryJson, serializeInventory } from '../core/inventory';
import {
  loadComparisonBaseline,
  loadInventory,
  saveComparisonBaseline,
} from './inventory-store';
import {
  loadWebDavConfig,
  loadWebDavRemoteVersion,
  saveWebDavConfig,
  saveWebDavRemoteVersion,
} from './webdav-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export async function pullWebDavInventory() {
  const backend = await configuredBackend();
  const remote = await backend.read();
  if (!remote) {
    throw new BackendError('not_found', 'No hsync inventory exists at this WebDAV location yet.');
  }
  const inventory = parseInventoryJson(decoder.decode(remote.data));
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveWebDavRemoteVersion(remote.version),
  ]);
  return inventory;
}

export async function uploadWebDavInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before uploading.');

  const [knownVersion, baseline] = await Promise.all([
    loadWebDavRemoteVersion(),
    loadComparisonBaseline(),
  ]);
  if (baseline && !knownVersion) {
    throw new BackendError(
      'conflict',
      'Pull the WebDAV inventory before replacing an imported comparison baseline.',
    );
  }
  const result = await backend.write({
    data: encoder.encode(serializeInventory(inventory)),
    expectedVersion: knownVersion,
  });
  await saveWebDavRemoteVersion(result.version);
  return inventory;
}

