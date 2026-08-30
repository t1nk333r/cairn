import { BackendError } from '../backends/contract';
import { GiteaBackend, normalizeGiteaConfig, type GiteaConfig } from '../backends/gitea';
import { parseInventoryJson, serializeInventory } from '../core/inventory';
import {
  loadComparisonBaseline,
  loadInventory,
  saveComparisonBaseline,
} from './inventory-store';
import {
  loadGiteaConfig,
  loadGiteaRemoteVersion,
  saveGiteaConfig,
  saveGiteaRemoteVersion,
} from './gitea-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function configuredBackend(): Promise<GiteaBackend> {
  const config = await loadGiteaConfig();
  if (!config) throw new BackendError('invalid_config', 'Configure Gitea first.');
  return new GiteaBackend(config);
}

export async function configureAndTestGitea(config: GiteaConfig) {
  const normalized = normalizeGiteaConfig(config);
  const backend = new GiteaBackend(normalized);
  await backend.testConnection();
  await saveGiteaConfig(normalized);
  return normalized;
}

export async function pullGiteaInventory() {
  const backend = await configuredBackend();
  const remote = await backend.read();
  if (!remote) {
    throw new BackendError('not_found', 'No hsync inventory exists at this repository path yet.');
  }
  const inventory = parseInventoryJson(decoder.decode(remote.data));
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveGiteaRemoteVersion(remote.version),
  ]);
  return inventory;
}

export async function uploadGiteaInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before uploading.');
  const [knownVersion, baseline] = await Promise.all([
    loadGiteaRemoteVersion(),
    loadComparisonBaseline(),
  ]);
  if (baseline && !knownVersion) {
    throw new BackendError(
      'conflict',
      'Pull the Gitea inventory before replacing an imported comparison baseline.',
    );
  }
  const result = await backend.write({
    data: encoder.encode(serializeInventory(inventory)),
    expectedVersion: knownVersion,
  });
  await saveGiteaRemoteVersion(result.version);
  return inventory;
}

