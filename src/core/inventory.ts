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

const CHROMIUM_STORE_ID = /^[a-p]{32}$/;

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

  return item.homepageUrl || item.updateUrl || undefined;
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
    (candidate.device.browserFamily === 'chromium' ||
      candidate.device.browserFamily === 'firefox') &&
    Array.isArray(candidate.extensions) &&
    candidate.extensions.every(
      (item) =>
        !!item &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.version === 'string' &&
        typeof item.enabled === 'boolean',
    )
  );
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
