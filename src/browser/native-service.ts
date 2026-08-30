import {
  createHelloRequest,
  createNativeRequest,
  NATIVE_HOST_NAME,
  parseHelloResponse,
  parseNativeResult,
  type NativeGitConfig,
  type NativeGitReadResult,
  type NativeGitWriteResult,
  type NativeHello,
} from '../native/protocol';
import { parseInventoryJson, serializeInventory } from '../core/inventory';
import { loadComparisonBaseline, loadInventory, saveComparisonBaseline } from './inventory-store';
import {
  loadNativeGitConfig,
  loadNativeGitRemoteVersion,
  saveNativeGitConfig,
  saveNativeGitRemoteVersion,
} from './native-git-store';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeConfig(config: NativeGitConfig): NativeGitConfig {
  return {
    remoteUrl: config.remoteUrl.trim(),
    branch: config.branch.trim(),
    filePath: config.filePath.trim(),
  };
}

function encodeBase64(data: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 0x8000) {
    binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sendNativeCommand(
  command: 'testConnection' | 'readInventory' | 'writeInventory',
  payload: object,
) {
  const request = createNativeRequest(command, payload);
  const response = await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, request);
  return parseNativeResult(response, request.requestId);
}

export async function detectNativeCompanion(): Promise<NativeHello> {
  const request = createHelloRequest();
  let response: unknown;
  try {
    response = await browser.runtime.sendNativeMessage(NATIVE_HOST_NAME, request);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not connect to hsyncd. Install and register the companion, then try again. ${detail}`);
  }
  return parseHelloResponse(response, request.requestId);
}

export async function configureAndTestNativeGit(config: NativeGitConfig) {
  const normalized = normalizeConfig(config);
  await sendNativeCommand('testConnection', normalized);
  await saveNativeGitConfig(normalized);
  return normalized;
}

export async function pullNativeGitInventory() {
  const config = await loadNativeGitConfig();
  if (!config) throw new Error('Configure native Git first.');
  const value = await sendNativeCommand('readInventory', config);
  if (value === null || value === undefined) {
    throw new Error('No hsync inventory exists at this Git path yet.');
  }
  if (!isObject(value) || typeof value.dataBase64 !== 'string' || typeof value.version !== 'string') {
    throw new Error('The native companion returned an invalid Git inventory response.');
  }
  const result = value as unknown as NativeGitReadResult;
  const inventory = parseInventoryJson(decoder.decode(decodeBase64(result.dataBase64)));
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveNativeGitRemoteVersion(result.version),
  ]);
  return inventory;
}

export async function uploadNativeGitInventory() {
  const [config, inventory, knownVersion, baseline] = await Promise.all([
    loadNativeGitConfig(),
    loadInventory(),
    loadNativeGitRemoteVersion(),
    loadComparisonBaseline(),
  ]);
  if (!config) throw new Error('Configure native Git first.');
  if (!inventory) throw new Error('Scan local extensions before committing.');
  if (baseline && !knownVersion) {
    throw new Error('Pull the native Git inventory before replacing an imported comparison baseline.');
  }
  const value = await sendNativeCommand('writeInventory', {
    ...config,
    dataBase64: encodeBase64(encoder.encode(serializeInventory(inventory))),
    expectedVersion: knownVersion,
  });
  if (!isObject(value) || typeof value.version !== 'string') {
    throw new Error('The native companion returned an invalid Git commit response.');
  }
  const result = value as unknown as NativeGitWriteResult;
  await saveNativeGitRemoteVersion(result.version);
  return inventory;
}
