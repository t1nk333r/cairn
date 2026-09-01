import { describe, expect, it, vi } from 'vitest';
import { buildS3ObjectUrl, normalizeS3Config, S3Backend } from '../src/backends/s3';
import { signS3Request } from '../src/backends/sigv4';

const config = {
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'hsync-bucket',
  objectKey: 'profiles/default/hsync.json',
  forcePathStyle: true,
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
};

describe('S3 endpoint handling', () => {
  it('builds path-style URLs for self-hosted services', () => {
    expect(buildS3ObjectUrl(config).href).toBe(
      'https://s3.example.test/hsync-bucket/profiles/default/hsync.json',
    );
  });

  it('builds virtual-host URLs for AWS-style services', () => {
    expect(
      buildS3ObjectUrl({ ...config, forcePathStyle: false }).href,
    ).toBe(
      'https://hsync-bucket.s3.example.test/profiles/default/hsync.json',
    );
  });

  it('allows local HTTP but rejects remote plain HTTP', () => {
    expect(
      normalizeS3Config({ ...config, endpoint: 'http://localhost:9000' }).endpoint,
    ).toBe('http://localhost:9000');
    expect(() =>
      normalizeS3Config({ ...config, endpoint: 'http://minio.example.test' }),
    ).toThrow('requires HTTPS');
  });
});

describe('SigV4 signing', () => {
  it('matches the published AWS S3 GET lifecycle signature vector', async () => {
    const headers = await signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2013-05-24T00:00:00.000Z'),
    });

    expect(headers.Authorization).toContain(
      'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('produces stable signed headers and signs a session token', async () => {
    const headers = await signS3Request({
      method: 'PUT',
      url: new URL('https://bucket.s3.us-east-1.amazonaws.com/hsync.json'),
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret-example',
        sessionToken: 'session-example',
      },
      payload: new TextEncoder().encode('{}'),
      now: new Date('2026-08-30T10:00:00.000Z'),
    });

    expect(headers['x-amz-date']).toBe('20260830T100000Z');
    expect(headers['x-amz-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['x-amz-security-token']).toBe('session-example');
    expect(headers.Authorization).toContain(
      'Credential=AKIDEXAMPLE/20260830/us-east-1/s3/aws4_request',
    );
    expect(headers.Authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    );
  });
});

describe('S3Backend', () => {
  it('uses a signed conditional PUT and returns ETag', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200, headers: { ETag: '"v2"' } }),
    );
    const backend = new S3Backend(config, {
      fetch: fetcher,
      now: () => new Date('2026-08-30T10:00:00.000Z'),
    });
    const result = await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: '"v1"',
    });
    const request = fetcher.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({
      'If-Match': '"v1"',
      'x-amz-date': '20260830T100000Z',
    });
    expect(result.version).toBe('"v2"');
  });

  it('surfaces missing CORS access as a network diagnostic', async () => {
    const backend = new S3Backend(config, {
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await expect(backend.testConnection()).rejects.toThrow(
      'Check the S3 endpoint and bucket CORS configuration',
    );
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
import { loadS3RemoteVersion, saveS3Config } from '../src/browser/s3-store';
import {
  pullS3Inventory,
  upgradeS3Inventory,
  uploadS3Inventory,
} from '../src/browser/s3-service';

// Routes the service layer's backend to an in-memory fake while leaving the
// direct `new S3Backend(config, { fetch })` constructions in the
// backend-class tests above untouched (they never arm `serviceBackend`).
const serviceBackend = vi.hoisted(() => ({
  current: null as null | {
    read(): Promise<BackendReadResult | null>;
    write(input: BackendWriteInput): Promise<BackendWriteResult>;
    testConnection(): Promise<void>;
  },
}));

vi.mock('../src/backends/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/backends/s3')>();
  class RoutedS3Backend extends actual.S3Backend {
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
  return { ...actual, S3Backend: RoutedS3Backend };
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

describe('S3 service (v2 sync path)', () => {
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
    await saveS3Config(normalizeS3Config(config));
  });

  afterEach(() => {
    serviceBackend.current = null;
    vi.unstubAllGlobals();
  });

  it('pull against an absent remote keeps its not_found wording', async () => {
    await expect(pullS3Inventory()).rejects.toMatchObject({
      code: 'not_found',
      message: 'No hsync inventory exists at this S3 object yet.',
    });
  });

  it('pull from a v2 remote returns this device projection and stores it as baseline', async () => {
    fake.seed(serializeInventoryV2(sharedRemote()));

    const inventory = await pullS3Inventory();

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions.map((entry) => entry.id)).toEqual([
      'shared-chromium-id',
    ]);
    expect(inventory.extensions[0]?.version).toBe('2.0.0');
    // Baseline is the projection, not the raw v2 document.
    expect(await loadComparisonBaseline()).toEqual(inventory);
    expect(await loadS3RemoteVersion()).toBe('v1');
  });

  it('pull from a v2 remote with no record for this device returns an empty projection', async () => {
    fake.seed(serializeInventoryV2(phoneOnlyRemote()));

    const inventory = await pullS3Inventory();

    expect(inventory.schemaVersion).toBe(1);
    expect(inventory.device.id).toBe('laptop');
    expect(inventory.extensions).toEqual([]);
    expect(inventory.generatedAt).toBe(T0);
  });

  it('pull from a v1 remote still returns the v1 document unchanged', async () => {
    const v1 = laptopCapture([item('legacy-ext', { name: 'Legacy' })]);
    fake.seed(serializeInventory(v1));

    const inventory = await pullS3Inventory();

    expect(inventory).toEqual(v1);
    expect(await loadComparisonBaseline()).toEqual(v1);
    expect(await loadS3RemoteVersion()).toBe('v1');
  });

  it('upload merges into the remote instead of overwriting the peer', async () => {
    fake.seed(serializeInventoryV2(phoneOnlyRemote()));
    await saveInventory(laptopCapture([item('laptop-tool', { name: 'Laptop Tool' })]));

    const inventory = await uploadS3Inventory();

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
    expect(await loadS3RemoteVersion()).toBe('v2');
  });

  it('upload against a v1 remote surfaces the upgrade conflict and writes nothing', async () => {
    fake.seed(serializeInventory(laptopCapture([item('legacy-ext')])));
    await saveInventory(laptopCapture([item('laptop-tool')]));

    await expect(uploadS3Inventory()).rejects.toMatchObject({
      code: 'conflict',
      message:
        'This remote still uses the single-device format. Run "Upgrade to multi-device inventory" before syncing.',
    });
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('upload without a local scan keeps its not_found wording', async () => {
    await expect(uploadS3Inventory()).rejects.toMatchObject({
      code: 'not_found',
      message: 'Scan local extensions before uploading.',
    });
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('upgrade lifts a v1 remote and writes it with the version from its own read', async () => {
    const v1 = laptopCapture([item('legacy-ext', { name: 'Legacy' })]);
    const seedVersion = fake.seed(serializeInventory(v1));

    const result = await upgradeS3Inventory();

    expect(result.upgraded).toBe(true);
    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBe(seedVersion);
    const written = parseInventoryJsonV2(fake.writtenText(0));
    expect(written.schemaVersion).toBe(2);
    expect(written.devices['laptop']).toBeDefined();
    expect(result.inventory.schemaVersion).toBe(1);
    expect(result.inventory.device.id).toBe('laptop');
    expect(result.inventory.extensions.map((entry) => entry.name)).toEqual(['Legacy']);
    expect(await loadS3RemoteVersion()).toBe('v2');
  });

  it('upgrade against an already-v2 remote reports upgraded: false and writes nothing', async () => {
    fake.seed(serializeInventoryV2(sharedRemote()));

    const result = await upgradeS3Inventory();

    expect(result.upgraded).toBe(false);
    expect(fake.writeCalls).toHaveLength(0);
    expect(result.inventory.device.id).toBe('laptop');
    expect(result.inventory.extensions.map((entry) => entry.id)).toEqual([
      'shared-chromium-id',
    ]);
    expect(await loadS3RemoteVersion()).toBe('v1');
  });
});
