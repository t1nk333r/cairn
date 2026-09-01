import { describe, expect, it, vi } from 'vitest';
import { GiteaBackend, normalizeGiteaConfig } from '../src/backends/gitea';

const config = {
  baseUrl: 'https://git.example.test/gitea/',
  token: 'token-example',
  owner: 'alice',
  repo: 'browser-sync',
  branch: 'main',
  filePath: 'devices/hsync.json',
};

describe('Gitea configuration', () => {
  it('preserves instance subpaths and normalizes the trailing slash', () => {
    expect(normalizeGiteaConfig(config).baseUrl).toBe(
      'https://git.example.test/gitea',
    );
  });

  it('rejects insecure non-local instances', () => {
    expect(() =>
      normalizeGiteaConfig({ ...config, baseUrl: 'http://git.example.test' }),
    ).toThrow('requires HTTPS');
  });
});

describe('GiteaBackend', () => {
  it('checks repository access and the configured branch', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({}),
    );
    const backend = new GiteaBackend(
      { ...config, branch: 'sync/devices' },
      { fetch: fetcher },
    );

    await backend.testConnection();

    expect(fetcher.mock.calls.map(([input]) => input)).toEqual([
      'https://git.example.test/gitea/api/v1/repos/alice/browser-sync',
      'https://git.example.test/gitea/api/v1/repos/alice/browser-sync/branches/sync%2Fdevices',
    ]);
  });

  it('reports a missing configured branch', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const backend = new GiteaBackend(config, { fetch: fetcher });

    await expect(backend.testConnection()).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('reads and decodes Base64 content with a blob SHA version', async () => {
    const payload = new TextEncoder().encode('{"schemaVersion":1}');
    let binary = '';
    for (const byte of payload) binary += String.fromCharCode(byte);
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: `${btoa(binary).slice(0, 8)}\n${btoa(binary).slice(8)}`,
          sha: 'blob-v1',
        }),
    );
    const backend = new GiteaBackend(config, { fetch: fetcher });
    const result = await backend.read();

    expect(new TextDecoder().decode(result?.data)).toBe('{"schemaVersion":1}');
    expect(result?.version).toBe('blob-v1');
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://git.example.test/gitea/api/v1/repos/alice/browser-sync/contents/devices/hsync.json?ref=main',
    );
  });

  it('creates a missing file with POST and no SHA', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ content: { sha: 'blob-v1' } }, { status: 201 }),
    );
    const backend = new GiteaBackend(config, { fetch: fetcher });
    await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: null,
    });
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(request?.method).toBe('POST');
    expect(body).not.toHaveProperty('sha');
    expect(body).toMatchObject({ branch: 'main', message: 'sync: update devices/hsync.json' });
  });

  it('updates with PUT and the expected blob SHA', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ content: { sha: 'blob-v2' } }),
    );
    const backend = new GiteaBackend(config, { fetch: fetcher });
    const result = await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: 'blob-v1',
    });
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(request?.method).toBe('PUT');
    expect(body.sha).toBe('blob-v1');
    expect(result.version).toBe('blob-v2');
  });

  it('maps stale-SHA validation failures to conflicts', async () => {
    const backend = new GiteaBackend(config, {
      fetch: vi.fn(async () => new Response(null, { status: 422 })),
    });
    await expect(
      backend.write({
        data: new TextEncoder().encode('{}'),
        expectedVersion: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 422 });
  });
});

// ---------------------------------------------------------------------------
// Service layer: pull/upload/upgrade through the v2 sync path.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach } from 'vitest';
import {
  BackendError,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
} from '../src/backends/contract';
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
import { loadGiteaRemoteVersion, saveGiteaConfig } from '../src/browser/gitea-store';
import {
  pullGiteaInventory,
  upgradeGiteaInventory,
  uploadGiteaInventory,
} from '../src/browser/gitea-service';

// Routes the service layer's backend to an in-memory fake while leaving the
// direct `new GiteaBackend(config, { fetch })` constructions in the
// backend-class tests above untouched (they never arm `serviceBackend`).
const serviceBackend = vi.hoisted(() => ({
  current: null as null | {
    read(): Promise<BackendReadResult | null>;
    write(input: BackendWriteInput): Promise<BackendWriteResult>;
    testConnection(): Promise<void>;
  },
}));

vi.mock('../src/backends/gitea', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/backends/gitea')>();
  class RoutedGiteaBackend extends actual.GiteaBackend {
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
  return { ...actual, GiteaBackend: RoutedGiteaBackend };
});

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

  seed(text: string): string {
    this.counter += 1;
    const version = `v${this.counter}`;
    this.stored = { data: encoder.encode(text), version };
    return version;
  }

  async read(): Promise<BackendReadResult | null> {
    return this.stored
      ? { data: this.stored.data, version: this.stored.version }
      : null;
  }

  async write(input: BackendWriteInput): Promise<BackendWriteResult> {
    this.writeCalls.push(input);
    const storedVersion = this.stored?.version ?? null;
    if (input.expectedVersion !== storedVersion) {
      throw new BackendError('conflict', 'remote changed since read', 412);
    }
    this.counter += 1;
    const version = `v${this.counter}`;
    this.stored = { data: input.data, version };
    return { version };
  }

  async testConnection(): Promise<void> {}

  writtenText(index: number): string {
    const call = this.writeCalls[index];
    if (!call) throw new Error(`no write call at index ${index}`);
    return decoder.decode(call.data);
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

describe('Gitea service (v2 sync path)', () => {
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
    await saveGiteaConfig(normalizeGiteaConfig(config));
  });

  afterEach(() => {
    serviceBackend.current = null;
    vi.unstubAllGlobals();
  });

  it('pull against an absent remote keeps its not_found wording', async () => {
    await expect(pullGiteaInventory()).rejects.toMatchObject({
      code: 'not_found',
      message: 'No hsync inventory exists at this repository path yet.',
    });
  });

  it('pull from a v2 remote returns this device projection and stores it as baseline', async () => {
    fake.seed(serializeInventoryV2(sharedRemote()));

    const inventory = await pullGiteaInventory();

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions.map((entry) => entry.id)).toEqual([
      'shared-chromium-id',
    ]);
    expect(inventory.extensions[0]?.version).toBe('2.0.0');
    // Baseline is the projection, not the raw v2 document.
    expect(await loadComparisonBaseline()).toEqual(inventory);
    expect(await loadGiteaRemoteVersion()).toBe('v1');
  });

  it('pull from a v2 remote with no record for this device returns an empty projection', async () => {
    fake.seed(serializeInventoryV2(phoneOnlyRemote()));

    const inventory = await pullGiteaInventory();

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions).toEqual([]);
    expect(inventory.generatedAt).toBe(T0);
  });

  it('pull from a v1 remote still returns the v1 document unchanged', async () => {
    const v1 = laptopCapture([item('legacy-ext', { name: 'Legacy' })]);
    fake.seed(serializeInventory(v1));

    const inventory = await pullGiteaInventory();

    expect(inventory).toEqual(v1);
    expect(await loadComparisonBaseline()).toEqual(v1);
    expect(await loadGiteaRemoteVersion()).toBe('v1');
  });

  it('upload merges into the remote instead of overwriting the peer', async () => {
    fake.seed(serializeInventoryV2(phoneOnlyRemote()));
    await saveInventory(laptopCapture([item('laptop-tool', { name: 'Laptop Tool' })]));

    const inventory = await uploadGiteaInventory();

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
    expect(await loadGiteaRemoteVersion()).toBe('v2');
  });

  it('upload against a v1 remote surfaces the upgrade conflict and writes nothing', async () => {
    fake.seed(serializeInventory(laptopCapture([item('legacy-ext')])));
    await saveInventory(laptopCapture([item('laptop-tool')]));

    await expect(uploadGiteaInventory()).rejects.toMatchObject({
      code: 'conflict',
      message:
        'This remote still uses the single-device format. Run "Upgrade to multi-device inventory" before syncing.',
    });
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('upload without a local scan keeps its not_found wording', async () => {
    await expect(uploadGiteaInventory()).rejects.toMatchObject({
      code: 'not_found',
      message: 'Scan local extensions before uploading.',
    });
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('upgrade lifts a v1 remote and writes it with the version from its own read', async () => {
    const v1 = laptopCapture([item('legacy-ext', { name: 'Legacy' })]);
    const seedVersion = fake.seed(serializeInventory(v1));

    const inventory = await upgradeGiteaInventory();

    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBe(seedVersion);
    const written = parseInventoryJsonV2(fake.writtenText(0));
    expect(written.schemaVersion).toBe(2);
    expect(written.devices['laptop']).toBeDefined();
    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions.map((entry) => entry.name)).toEqual(['Legacy']);
    expect(await loadGiteaRemoteVersion()).toBe('v2');
  });
});
