export const INVENTORY_SCHEMA_VERSION = 1 as const;

export type BrowserFamily = 'chromium' | 'firefox';

export interface DeviceObservation {
  id: string;
  label: string;
  browserFamily: BrowserFamily;
  browserName: string;
}

export interface ExtensionInventoryItem {
  id: string;
  browserFamily: BrowserFamily;
  name: string;
  version: string;
  enabled: boolean;
  type: string;
  installType?: string;
  homepageUrl?: string;
  updateUrl?: string;
  sourceUrl?: string;
  observedAt: string;
}

export interface InventoryDocument {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
  generatedAt: string;
  device: DeviceObservation;
  extensions: ExtensionInventoryItem[];
}

export interface ManagementExtensionInfo {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  type: string;
  installType?: string;
  homepageUrl?: string;
  updateUrl?: string;
}

export interface ManagementApi {
  getAll(): Promise<ManagementExtensionInfo[]>;
  getSelf(): Promise<ManagementExtensionInfo>;
}

export interface CaptureInventoryInput {
  management: ManagementApi;
  device: DeviceObservation;
  now?: () => Date;
}

export class InventoryFormatError extends Error {
  constructor(
    public readonly code:
      | 'invalid_json'
      | 'invalid_inventory'
      | 'unsupported_schema',
    message: string,
  ) {
    super(message);
    this.name = 'InventoryFormatError';
  }
}

const CHROMIUM_STORE_ID = /^[a-p]{32}$/;

// Extension-supplied URLs end up rendered as clickable links in a page that
// holds the `management` permission, so only ordinary web schemes may survive.
// `javascript:`, `data:`, and friends are dropped rather than sanitized.
export function safeExternalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''),
  ) as T;
}

export function inferSourceUrl(
  item: ManagementExtensionInfo,
  browserFamily: BrowserFamily,
): string | undefined {
  if (browserFamily === 'chromium' && CHROMIUM_STORE_ID.test(item.id)) {
    return `https://chromewebstore.google.com/detail/${item.id}`;
  }

  return safeExternalUrl(item.homepageUrl) ?? safeExternalUrl(item.updateUrl);
}

export function normalizeExtension(
  item: ManagementExtensionInfo,
  browserFamily: BrowserFamily,
  observedAt: string,
): ExtensionInventoryItem {
  return defined({
    id: item.id,
    browserFamily,
    name: item.name.trim(),
    version: item.version,
    enabled: item.enabled,
    type: item.type,
    installType: item.installType,
    homepageUrl: item.homepageUrl,
    updateUrl: item.updateUrl,
    sourceUrl: inferSourceUrl(item, browserFamily),
    observedAt,
  } as ExtensionInventoryItem);
}

export async function captureInventory({
  management,
  device,
  now = () => new Date(),
}: CaptureInventoryInput): Promise<InventoryDocument> {
  const [installed, self] = await Promise.all([
    management.getAll(),
    management.getSelf(),
  ]);
  const observedAt = now().toISOString();
  const extensions = installed
    .filter((item) => item.id !== self.id && item.type === 'extension')
    .map((item) => normalizeExtension(item, device.browserFamily, observedAt))
    .sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );

  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: observedAt,
    device,
    extensions,
  };
}

export function isInventoryDocument(value: unknown): value is InventoryDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InventoryDocument>;
  return (
    candidate.schemaVersion === INVENTORY_SCHEMA_VERSION &&
    typeof candidate.generatedAt === 'string' &&
    !!candidate.device &&
    typeof candidate.device.id === 'string' &&
    typeof candidate.device.label === 'string' &&
    typeof candidate.device.browserName === 'string' &&
    (candidate.device.browserFamily === 'chromium' ||
      candidate.device.browserFamily === 'firefox') &&
    Array.isArray(candidate.extensions) &&
    candidate.extensions.every(
      (item) =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.version === 'string' &&
        typeof item.enabled === 'boolean' &&
        typeof item.type === 'string' &&
        typeof item.observedAt === 'string' &&
        (item.sourceUrl === undefined || typeof item.sourceUrl === 'string') &&
        (item.homepageUrl === undefined || typeof item.homepageUrl === 'string') &&
        (item.updateUrl === undefined || typeof item.updateUrl === 'string') &&
        (item.browserFamily === 'chromium' || item.browserFamily === 'firefox'),
    )
  );
}

export function parseInventoryJson(text: string): InventoryDocument {
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
      INVENTORY_SCHEMA_VERSION
  ) {
    throw new InventoryFormatError(
      'unsupported_schema',
      `This inventory uses unsupported schema version ${String((value as { schemaVersion?: unknown }).schemaVersion)}.`,
    );
  }

  if (!isInventoryDocument(value)) {
    throw new InventoryFormatError(
      'invalid_inventory',
      'The selected JSON file is not a valid Cairn inventory.',
    );
  }

  return {
    ...value,
    extensions: [...value.extensions].sort((left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  };
}

export function serializeInventory(inventory: InventoryDocument): string {
  const canonical: InventoryDocument = {
    ...inventory,
    extensions: [...inventory.extensions].sort((left, right) =>
      `${left.browserFamily}:${left.id}`.localeCompare(
        `${right.browserFamily}:${right.id}`,
      ),
    ),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
