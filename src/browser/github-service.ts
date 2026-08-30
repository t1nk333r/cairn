import { BackendError } from '../backends/contract';
import { GitHubBackend, normalizeGitHubConfig, type GitHubConfig } from '../backends/github';
import { parseInventoryJson, serializeInventory } from '../core/inventory';
import { loadComparisonBaseline, loadInventory, saveComparisonBaseline } from './inventory-store';
import {
  loadGitHubConfig,
  loadGitHubRemoteVersion,
  saveGitHubConfig,
  saveGitHubRemoteVersion,
} from './github-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export async function pullGitHubInventory() {
  const backend = await configuredBackend();
  const remote = await backend.read();
  if (!remote) throw new BackendError('not_found', 'No hsync inventory exists at this Git path yet.');
  const inventory = parseInventoryJson(decoder.decode(remote.data));
  await Promise.all([saveComparisonBaseline(inventory), saveGitHubRemoteVersion(remote.version)]);
  return inventory;
}

export async function uploadGitHubInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before committing.');
  const [knownVersion, baseline] = await Promise.all([
    loadGitHubRemoteVersion(),
    loadComparisonBaseline(),
  ]);
  if (baseline && !knownVersion) {
    throw new BackendError('conflict', 'Pull the Git inventory before replacing an imported comparison baseline.');
  }
  const result = await backend.write({
    data: encoder.encode(serializeInventory(inventory)),
    expectedVersion: knownVersion,
  });
  await saveGitHubRemoteVersion(result.version);
  return inventory;
}
