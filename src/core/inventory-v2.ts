// Schema v2: the multi-device inventory document (types, validator, parser,
// canonical serializer). Nothing consumes this yet — v1 in `./inventory` is
// still the shipping format. The design this implements is
// `docs/design/inventory-schema-v2.md`.
import { InventoryFormatError, type BrowserFamily } from './inventory';

export const INVENTORY_SCHEMA_VERSION_V2 = 2 as const;

export interface DeviceRecord {
  label: string;
  browserFamily: BrowserFamily;
  lastSeenAt: string; // ISO 8601
}

export interface DeviceExtensionState {
  installed: boolean;
  enabled: boolean;
  version: string;
  observedAt: string;
  deletedAt?: string;
}

export interface ExtensionRecord {
  name: string;
  aliases: Partial<Record<BrowserFamily, string[]>>;
  sources?: Partial<Record<BrowserFamily, string>>;
  homepageUrl?: string;
  stateByDevice: Record<string, DeviceExtensionState>;
}

export interface InventoryDocumentV2 {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION_V2;
  revision: string;
  updatedAt: string;
  devices: Record<string, DeviceRecord>;
  extensions: Record<string, ExtensionRecord>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isBrowserFamily(value: unknown): value is BrowserFamily {
  return value === 'chromium' || value === 'firefox';
}

function isDeviceRecord(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.label === 'string' &&
    typeof value.lastSeenAt === 'string' &&
    isBrowserFamily(value.browserFamily)
  );
}

function isDeviceExtensionState(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    typeof value.installed === 'boolean' &&
    typeof value.enabled === 'boolean' &&
    typeof value.version === 'string' &&
    typeof value.observedAt === 'string' &&
    (!('deletedAt' in value) || typeof value.deletedAt === 'string')
  );
}

function isAliasMap(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.keys(value).length > 0 &&
    Object.entries(value).every(
      ([family, ids]) =>
        isBrowserFamily(family) &&
        Array.isArray(ids) &&
        ids.length > 0 &&
        ids.every((id) => typeof id === 'string'),
    )
  );
}

function isSourceMap(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.entries(value).every(
      ([family, url]) => isBrowserFamily(family) && typeof url === 'string',
    )
  );
}

function isExtensionRecord(value: unknown): value is ExtensionRecord {
  return (
    isPlainObject(value) &&
    typeof value.name === 'string' &&
    isAliasMap(value.aliases) &&
    (!('sources' in value) || isSourceMap(value.sources)) &&
    (!('homepageUrl' in value) || typeof value.homepageUrl === 'string') &&
    isPlainObject(value.stateByDevice) &&
    Object.values(value.stateByDevice).every(isDeviceExtensionState)
  );
}

export function isInventoryDocumentV2(
  value: unknown,
): value is InventoryDocumentV2 {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== INVENTORY_SCHEMA_VERSION_V2) return false;
  if (typeof value.revision !== 'string') return false;
  if (typeof value.updatedAt !== 'string') return false;

  const devices = value.devices;
  if (!isPlainObject(devices)) return false;
  if (!Object.values(devices).every(isDeviceRecord)) return false;

  const extensions = value.extensions;
  if (!isPlainObject(extensions)) return false;
  for (const record of Object.values(extensions)) {
    if (!isExtensionRecord(record)) return false;
    // Referential integrity: a document whose state references a device that
    // is not in the top-level `devices` map is corrupt.
    for (const deviceId of Object.keys(record.stateByDevice)) {
      if (!(deviceId in devices)) return false;
    }
  }

  return true;
}

export function parseInventoryJsonV2(text: string): InventoryDocumentV2 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InventoryFormatError(
      'invalid_json',
      'The selected file is not valid JSON.',
    );
  }

  if (
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    (value as { schemaVersion?: unknown }).schemaVersion !==
      INVENTORY_SCHEMA_VERSION_V2
  ) {
    throw new InventoryFormatError(
      'unsupported_schema',
      `This inventory uses unsupported schema version ${String((value as { schemaVersion?: unknown }).schemaVersion)}.`,
    );
  }

  if (!isInventoryDocumentV2(value)) {
    throw new InventoryFormatError(
      'invalid_inventory',
      'The selected JSON file is not a valid hsync inventory.',
    );
  }

  return value;
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function canonicalAliases(
  aliases: Partial<Record<BrowserFamily, string[]>>,
): Partial<Record<BrowserFamily, string[]>> {
  return {
    ...(aliases.chromium ? { chromium: [...aliases.chromium].sort() } : {}),
    ...(aliases.firefox ? { firefox: [...aliases.firefox].sort() } : {}),
  };
}

function canonicalSources(
  sources: Partial<Record<BrowserFamily, string>>,
): Partial<Record<BrowserFamily, string>> {
  return {
    ...(sources.chromium !== undefined ? { chromium: sources.chromium } : {}),
    ...(sources.firefox !== undefined ? { firefox: sources.firefox } : {}),
  };
}

function canonicalExtensionRecord(record: ExtensionRecord): ExtensionRecord {
  return {
    name: record.name,
    aliases: canonicalAliases(record.aliases),
    ...(record.sources !== undefined
      ? { sources: canonicalSources(record.sources) }
      : {}),
    ...(record.homepageUrl !== undefined
      ? { homepageUrl: record.homepageUrl }
      : {}),
    stateByDevice: sortedRecord(record.stateByDevice),
  };
}

export function serializeInventoryV2(document: InventoryDocumentV2): string {
  const canonical: InventoryDocumentV2 = {
    schemaVersion: document.schemaVersion,
    revision: document.revision,
    updatedAt: document.updatedAt,
    devices: sortedRecord(document.devices),
    extensions: sortedRecord(
      Object.fromEntries(
        Object.entries(document.extensions).map(([id, record]) => [
          id,
          canonicalExtensionRecord(record),
        ]),
      ),
    ),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
