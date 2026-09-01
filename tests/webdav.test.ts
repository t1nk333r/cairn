import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BackendError,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
} from '../src/backends/contract';
import {
  WebDavBackend,
  normalizeWebDavConfig,
  webDavOriginPattern,
} from '../src/backends/webdav';
import {
  serializeInventory,
  type ExtensionInventoryItem,
  type InventoryDocument,
} from '../src/core/inventory';
import {
  parseInventoryJsonV2,
  serializeInventoryV2,
  type InventoryDocumentV2,
} from '../src/core/inventory-v2';
import {
  loadComparisonBaseline,
  saveInventory,
} from '../src/browser/inventory-store';
import {
  loadWebDavRemoteVersion,
  saveWebDavConfig,
} from '../src/browser/webdav-store';
import {
  pullWebDavInventory,
  upgradeWebDavInventory,
  uploadWebDavInventory,
} from '../src/browser/webdav-service';

// Routes the service layer's backend to an in-memory fake while leaving the
// direct `new WebDavBackend(config, { fetch })` constructions in the
// backend-class tests below untouched (they never arm `serviceBackend`).
const serviceBackend = vi.hoisted(() => ({
  current: null as null | {
    read(): Promise<BackendReadResult | null>;
    write(input: BackendWriteInput): Promise<BackendWriteResult>;
    testConnection(): Promise<void>;
  },
}));

vi.mock('../src/backends/webdav', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/backends/webdav')>();
  class RoutedWebDavBackend extends actual.WebDavBackend {
    override read(): Promise<BackendReadResult | null> {
      return serviceBackend.current ? serviceBackend.current.read() : super.read();
    }
    override write(input: BackendWriteInput): Promise<BackendWriteResult> {
      return serviceBackend.current
        ? serviceBackend.current.write(input)
        : super.write(input);
    }
    override testConnection(): Promise<void> {
      return serviceBackend.current
        ? serviceBackend.current.testConnection()
        : super.testConnection();
    }
  }
  return { ...actual, WebDavBackend: RoutedWebDavBackend };
});

const config = {
  baseUrl: 'https://dav.example.test/remote/user/hsync',
  fileName: 'hsync.json',
  username: 'alice',
  password: 'app-password',
};

describe('WebDavBackend', () => {
  it('normalizes folders and produces a narrow origin permission', () => {
    expect(normalizeWebDavConfig(config).baseUrl).toBe(
      'https://dav.example.test/remote/user/hsync/',
    );
    expect(webDavOriginPattern(config.baseUrl)).toBe('https://dav.example.test/*');
  });

  it('rejects insecure non-local endpoints', () => {
    expect(() =>
      normalizeWebDavConfig({ ...config, baseUrl: 'http://dav.example.test/files/' }),
    ).toThrow('requires HTTPS');
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() =>
      normalizeWebDavConfig({
        ...config,
        baseUrl: 'https://alice:secret@dav.example.test/files/',
      }),
    ).toThrow('Do not put credentials');
  });

  it('reads bytes and requires an ETag', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"schemaVersion":1}', {
        status: 200,
        headers: { ETag: '"v1"' },
      }),
    );
    const backend = new WebDavBackend(config, { fetch: fetcher });
    const result = await backend.read();

    expect(new TextDecoder().decode(result?.data)).toBe('{"schemaVersion":1}');
    expect(result?.version).toBe('"v1"');
    expect(fetcher).toHaveBeenCalledWith(
      'https://dav.example.test/remote/user/hsync/hsync.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses If-Match for an update and returns the new ETag', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204, headers: { ETag: '"v2"' } }),
    );
    const backend = new WebDavBackend(config, { fetch: fetcher });
    const result = await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: '"v1"',
    });

    const request = fetcher.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ 'If-Match': '"v1"' });
    expect(result.version).toBe('"v2"');
  });

  it('surfaces precondition failures as conflicts', async () => {
    const backend = new WebDavBackend(config, {
      fetch: vi.fn(async () => new Response(null, { status: 412 })),
    });

    await expect(
      backend.write({
        data: new TextEncoder().encode('{}'),
        expectedVersion: '"stale"',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 412 } satisfies Partial<BackendError>);
  });
});

// ---------------------------------------------------------------------------
// Service layer: pull/upload/upgrade through the v2 sync path.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const T0 = '2026-08-30T10:00:00.000Z';
const NOW = '2026-09-01T12:00:00.000Z';

// In-memory conditional-write backend, same semantics as the real ones:
// monotonically counted versions, `conflict` on an expectedVersion mismatch.
class MemoryBackend {
  private stored: { data: Uint8Array; version: string } | null = null;
  private counter = 0;
  writeCalls: BackendWriteInput[] = [];
  /** Runs between the client's read and its write — a peer's racing write. */
  afterNextRead: (() => Promise<void>) | null = null;

  seed(text: string): string {
    return this.commit(encoder.encode(text));
  }

  async read(): Promise<BackendReadResult | null> {
    const snapshot = this.stored
      ? { data: this.stored.data, version: this.stored.version }
      : null;
    const hook = this.afterNextRead;
    if (hook) {
      this.afterNextRead = null;
      await hook();
    }
    return snapshot;
  }

  async write(input: BackendWriteInput): Promise<BackendWriteResult> {
    this.writeCalls.push(input);
    return this.applyWrite(input);
  }

  /** A peer's write: same conditional semantics, not logged in `writeCalls`. */
  async peerWrite(input: BackendWriteInput): Promise<BackendWriteResult> {
    return this.applyWrite(input);
  }

  async testConnection(): Promise<void> {}

  writtenText(index: number): string {
    const call = this.writeCalls[index];
    if (!call) throw new Error(`no write call at index ${index}`);
    return decoder.decode(call.data);
  }

  storedText(): string {
    if (!this.stored) throw new Error('nothing stored');
    return decoder.decode(this.stored.data);
  }

  private applyWrite(input: BackendWriteInput): BackendWriteResult {
    const storedVersion = this.stored?.version ?? null;
    if (input.expectedVersion !== storedVersion) {
      throw new BackendError('conflict', 'remote changed since read', 412);
    }
    return { version: this.commit(input.data) };
  }

  private commit(data: Uint8Array): string {
    this.counter += 1;
    const version = `v${this.counter}`;
    this.stored = { data, version };
    return version;
  }
}

const storageData = new Map<string, unknown>();
const fakeBrowser = {
  storage: {
    local: {
      async get(keys?: string | string[]) {
        const wanted =
          keys === undefined
            ? [...storageData.keys()]
            : Array.isArray(keys)
              ? keys
              : [keys];
        const out: Record<string, unknown> = {};
        for (const key of wanted) {
          if (storageData.has(key)) out[key] = storageData.get(key);
        }
        return out;
      },
      async set(items: Record<string, unknown>) {
        for (const [key, value] of Object.entries(items)) {
          storageData.set(key, value);
        }
      },
      async remove(keys: string | string[]) {
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          storageData.delete(key);
        }
      },
    },
  },
};

const item = (
  id: string,
  overrides: Partial<ExtensionInventoryItem> = {},
): ExtensionInventoryItem => ({
  id,
  browserFamily: 'chromium',
  name: id,
  version: '1.0.0',
  enabled: true,
  type: 'extension',
  observedAt: NOW,
  ...overrides,
});

const laptopCapture = (
  extensions: ExtensionInventoryItem[],
): InventoryDocument => ({
  schemaVersion: 1,
  generatedAt: NOW,
  device: {
    id: 'laptop',
    label: 'Laptop',
    browserFamily: 'chromium',
    browserName: 'Chromium',
  },
  extensions,
});

// A v2 remote holding both the laptop's and a peer phone's observations.
const sharedRemote = (): InventoryDocumentV2 => ({
  schemaVersion: 2,
  revision: '2',
  updatedAt: T0,
  devices: {
    laptop: { label: 'Laptop', browserFamily: 'chromium', lastSeenAt: T0 },
    phone: { label: 'Phone', browserFamily: 'firefox', lastSeenAt: T0 },
  },
  extensions: {
    'ext-shared': {
      name: 'Shared Tool',
      aliases: { chromium: ['shared-chromium-id'], firefox: ['shared@firefox'] },
      stateByDevice: {
        laptop: { installed: true, enabled: true, version: '2.0.0', observedAt: T0 },
        phone: { installed: true, enabled: false, version: '1.9.0', observedAt: T0 },
      },
    },
    'ext-phone': {
      name: 'Phone Reader',
      aliases: { firefox: ['reader@firefox'] },
      stateByDevice: {
        phone: { installed: true, enabled: true, version: '1.0.0', observedAt: T0 },
      },
    },
  },
});

// The same remote with only the phone's record — this device is unknown.
const phoneOnlyRemote = (): InventoryDocumentV2 => {
  const document = sharedRemote();
  delete document.devices['laptop'];
  delete document.extensions['ext-shared']?.stateByDevice['laptop'];
  return document;
};

describe('WebDAV service (v2 sync path)', () => {
  let fake: MemoryBackend;

  beforeEach(async () => {
    storageData.clear();
    vi.stubGlobal('browser', fakeBrowser);
    fake = new MemoryBackend();
    serviceBackend.current = fake;
    await fakeBrowser.storage.local.set({
      deviceId: 'laptop',
      deviceLabel: 'Laptop',
    });
    await saveWebDavConfig(normalizeWebDavConfig(config));
  });

  afterEach(() => {
    serviceBackend.current = null;
    vi.unstubAllGlobals();
  });

  it('pull against an absent remote keeps its not_found wording', async () => {
    await expect(pullWebDavInventory()).rejects.toMatchObject({
      code: 'not_found',
      message: 'No hsync inventory exists at this WebDAV location yet.',
    });
  });

  it('pull from a v2 remote returns this device projection and stores it as baseline', async () => {
    fake.seed(serializeInventoryV2(sharedRemote()));

    const inventory = await pullWebDavInventory();

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions.map((entry) => entry.id)).toEqual([
      'shared-chromium-id',
    ]);
    expect(inventory.extensions[0]?.version).toBe('2.0.0');
    // Baseline is the projection, not the raw v2 document.
    expect(await loadComparisonBaseline()).toEqual(inventory);
    expect(await loadWebDavRemoteVersion()).toBe('v1');
  });

  it('pull from a v2 remote with no record for this device returns an empty projection', async () => {
    fake.seed(serializeInventoryV2(phoneOnlyRemote()));

    const inventory = await pullWebDavInventory();

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions).toEqual([]);
    expect(inventory.generatedAt).toBe(T0);
  });

  it('pull from a v1 remote still returns the v1 document unchanged', async () => {
    const v1 = laptopCapture([item('legacy-ext', { name: 'Legacy' })]);
    fake.seed(serializeInventory(v1));

    const inventory = await pullWebDavInventory();

    expect(inventory).toEqual(v1);
    expect(await loadComparisonBaseline()).toEqual(v1);
    expect(await loadWebDavRemoteVersion()).toBe('v1');
  });

  it('upload merges into the remote instead of overwriting the peer', async () => {
    fake.seed(serializeInventoryV2(phoneOnlyRemote()));
    await saveInventory(laptopCapture([item('laptop-tool', { name: 'Laptop Tool' })]));

    const inventory = await uploadWebDavInventory();

    // The load-bearing assertion: the bytes actually written still carry the
    // peer's state. Under the old whole-document overwrite they would not.
    expect(fake.writeCalls).toHaveLength(1);
    const written = parseInventoryJsonV2(fake.writtenText(0));
    expect(written.devices['phone']).toBeDefined();
    expect(
      written.extensions['ext-phone']?.stateByDevice['phone'],
    ).toMatchObject({ installed: true, version: '1.0.0' });
    expect(written.devices['laptop']).toBeDefined();
    // The caller still receives this device's v1-shaped projection.
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions.map((entry) => entry.name)).toContain('Laptop Tool');
    expect(await loadWebDavRemoteVersion()).toBe('v2');
  });

  it('upload against a v1 remote surfaces the upgrade conflict and writes nothing', async () => {
    fake.seed(serializeInventory(laptopCapture([item('legacy-ext')])));
    await saveInventory(laptopCapture([item('laptop-tool')]));

    await expect(uploadWebDavInventory()).rejects.toMatchObject({
      code: 'conflict',
      message:
        'This remote still uses the single-device format. Run "Upgrade to multi-device inventory" before syncing.',
    });
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('upload without a local scan keeps its not_found wording', async () => {
    await expect(uploadWebDavInventory()).rejects.toMatchObject({
      code: 'not_found',
      message: 'Scan local extensions before uploading.',
    });
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('upload against an absent remote creates the document', async () => {
    await saveInventory(laptopCapture([item('laptop-tool', { name: 'Laptop Tool' })]));

    const inventory = await uploadWebDavInventory();

    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBeNull();
    const written = parseInventoryJsonV2(fake.writtenText(0));
    expect(written.devices['laptop']).toBeDefined();
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions.map((entry) => entry.name)).toEqual(['Laptop Tool']);
  });

  it('upload retries a conflicting write and still preserves the peer state', async () => {
    const seedVersion = fake.seed(serializeInventoryV2(phoneOnlyRemote()));
    await saveInventory(laptopCapture([item('laptop-tool', { name: 'Laptop Tool' })]));

    // A peer write lands between this device's read and its write.
    const racingPeer = phoneOnlyRemote();
    racingPeer.extensions['ext-phone']!.stateByDevice['phone']!.version = '1.1.0';
    fake.afterNextRead = async () => {
      await fake.peerWrite({
        data: encoder.encode(serializeInventoryV2(racingPeer)),
        expectedVersion: seedVersion,
      });
    };

    const inventory = await uploadWebDavInventory();

    // First write conflicted, the retry succeeded against the fresh fetch.
    expect(fake.writeCalls).toHaveLength(2);
    const finalDocument = parseInventoryJsonV2(fake.storedText());
    expect(
      finalDocument.extensions['ext-phone']?.stateByDevice['phone'],
    ).toMatchObject({ version: '1.1.0' });
    expect(finalDocument.devices['laptop']).toBeDefined();
    expect(inventory.device.id).toBe('laptop');
  });

  it('upgrade lifts a v1 remote and writes it with the version from its own read', async () => {
    const v1 = laptopCapture([item('legacy-ext', { name: 'Legacy' })]);
    const seedVersion = fake.seed(serializeInventory(v1));

    const result = await upgradeWebDavInventory();

    expect(result.upgraded).toBe(true);
    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBe(seedVersion);
    const written = parseInventoryJsonV2(fake.writtenText(0));
    expect(written.schemaVersion).toBe(2);
    expect(written.devices['laptop']).toBeDefined();
    expect(result.inventory.schemaVersion).toBe(1);
    expect(result.inventory.device.id).toBe('laptop');
    expect(result.inventory.extensions.map((entry) => entry.name)).toEqual(['Legacy']);
    expect(await loadWebDavRemoteVersion()).toBe('v2');
  });

  it('upgrade against an already-v2 remote reports upgraded: false and writes nothing', async () => {
    fake.seed(serializeInventoryV2(sharedRemote()));

    const result = await upgradeWebDavInventory();

    expect(result.upgraded).toBe(false);
    expect(fake.writeCalls).toHaveLength(0);
    expect(result.inventory.device.id).toBe('laptop');
    expect(result.inventory.extensions.map((entry) => entry.id)).toEqual([
      'shared-chromium-id',
    ]);
    expect(await loadWebDavRemoteVersion()).toBe('v1');
  });
});
