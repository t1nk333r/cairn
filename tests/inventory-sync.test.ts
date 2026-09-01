import { describe, expect, it } from 'vitest';
import {
  BackendError,
  type BackendErrorCode,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
  type InventoryBackend,
} from '../src/backends/contract';
import {
  InventoryFormatError,
  type ExtensionInventoryItem,
  type InventoryDocument,
} from '../src/core/inventory';
import { mergeLocalObservation } from '../src/core/inventory-merge';
import {
  isInventoryDocumentV2,
  parseInventoryJsonV2,
  serializeInventoryV2,
  type InventoryDocumentV2,
} from '../src/core/inventory-v2';
import {
  readRemoteDocument,
  syncV2,
  upgradeRemoteToV2,
} from '../src/browser/inventory-sync';

const T0 = '2026-08-30T10:00:00.000Z';
const PEER_NOW = '2026-09-01T11:00:00.000Z';
const NOW = '2026-09-01T12:00:00.000Z';

const at = (iso: string) => () => new Date(iso);

const sequentialIds = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// In-memory conditional-write backend. Versions are a monotonically
// increasing counter (`v1`, `v2`, …); a write whose `expectedVersion` does
// not match the stored version throws `BackendError('conflict')`, exactly
// like the real backends' If-Match/412 path. `writeCalls` logs only the
// client under test — a peer's concurrent write goes through `peerWrite`,
// which shares the conditional semantics but not the log.
class FakeBackend implements InventoryBackend {
  private stored: { data: Uint8Array; version: string } | null = null;
  private counter = 0;
  readCount = 0;
  writeCalls: BackendWriteInput[] = [];
  /** When set, `write` throws this code instead of storing anything. */
  failWritesWith: BackendErrorCode | null = null;
  /**
   * Runs once, after the next `read` has taken its snapshot but before that
   * snapshot is returned — i.e. between the client's read and its write.
   * This is how a peer's racing write is injected deterministically.
   */
  afterNextRead: (() => Promise<void>) | null = null;

  seed(text: string): string {
    return this.commit(encoder.encode(text));
  }

  async read(): Promise<BackendReadResult | null> {
    this.readCount += 1;
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
    if (this.failWritesWith) {
      throw new BackendError(this.failWritesWith, `forced ${this.failWritesWith}`);
    }
    return this.applyWrite(input);
  }

  async peerWrite(input: BackendWriteInput): Promise<BackendWriteResult> {
    return this.applyWrite(input);
  }

  async testConnection(): Promise<void> {}

  private applyWrite(input: BackendWriteInput): BackendWriteResult {
    const storedVersion = this.stored?.version ?? null;
    if (input.expectedVersion !== storedVersion) {
      throw new BackendError(
        'conflict',
        `expected version ${String(input.expectedVersion)} but remote holds ${String(storedVersion)}`,
        412,
      );
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

const phoneCapture = (
  extensions: ExtensionInventoryItem[],
): InventoryDocument => ({
  schemaVersion: 1,
  generatedAt: PEER_NOW,
  device: {
    id: 'phone',
    label: 'Phone',
    browserFamily: 'firefox',
    browserName: 'Firefox',
  },
  extensions,
});

// A v2 remote already holding the phone's observations.
const seededRemote = (): InventoryDocumentV2 => ({
  schemaVersion: 2,
  revision: '1',
  updatedAt: T0,
  devices: {
    phone: { label: 'Phone', browserFamily: 'firefox', lastSeenAt: T0 },
  },
  extensions: {
    'ext-phone': {
      name: 'Phone Reader',
      aliases: { firefox: ['reader@firefox'] },
      stateByDevice: {
        phone: {
          installed: true,
          enabled: true,
          version: '1.0.0',
          observedAt: T0,
        },
      },
    },
  },
});

const laptopSync = (backend: InventoryBackend, maxAttempts?: number) =>
  syncV2({
    backend,
    local: laptopCapture([item('laptop-tool-id', { name: 'Laptop Tool' })]),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    now: at(NOW),
    newExtensionId: sequentialIds('laptop-minted'),
  });

// Seeds the phone-only remote, then arms the fake so that a genuine peer
// write lands between the laptop's read and its write: the phone merges its
// own fresh capture (bumping `reader@firefox` to 1.1.0 and minting
// `peer-minted-1`) into the same document the laptop just fetched, and
// commits it through the conditional-write path with the seeded version.
const arrangePeerRace = () => {
  const fake = new FakeBackend();
  const docA = seededRemote();
  const seedVersion = fake.seed(serializeInventoryV2(docA));
  const peerDocument = mergeLocalObservation({
    remote: docA,
    local: phoneCapture([
      item('reader@firefox', {
        browserFamily: 'firefox',
        name: 'Phone Reader',
        version: '1.1.0',
        observedAt: PEER_NOW,
      }),
      item('peer-new@firefox', {
        browserFamily: 'firefox',
        name: 'Peer New',
        observedAt: PEER_NOW,
      }),
    ]),
    now: at(PEER_NOW),
    newExtensionId: () => 'peer-minted-1',
  });
  fake.afterNextRead = async () => {
    await fake.peerWrite({
      data: encoder.encode(serializeInventoryV2(peerDocument)),
      expectedVersion: seedVersion,
    });
  };
  return { fake, peerDocument };
};

const caught = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (error: unknown) => error,
  );

describe('syncV2', () => {
  it('creates a v2 document on an absent remote with expectedVersion null', async () => {
    const fake = new FakeBackend();
    const result = await laptopSync(fake);

    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBeNull();
    expect(result.attempts).toBe(1);
    expect(isInventoryDocumentV2(result.document)).toBe(true);
    expect(Object.keys(result.document.devices)).toEqual(['laptop']);
    expect(result.version).toBe('v1');
  });

  it('merges into a v2 remote and writes with the fetched version', async () => {
    const fake = new FakeBackend();
    fake.seed(serializeInventoryV2(seededRemote()));

    const result = await laptopSync(fake);

    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBe('v1');
    expect(result.attempts).toBe(1);
    // The merge extended the union rather than replacing it.
    expect(Object.keys(result.document.devices).sort()).toEqual([
      'laptop',
      'phone',
    ]);
    expect(
      result.document.extensions['ext-phone']?.stateByDevice['phone'],
    ).toBeDefined();
  });

  it('refuses a v1 remote without writing anything', async () => {
    const fake = new FakeBackend();
    fake.seed(JSON.stringify(phoneCapture([item('reader@firefox')])));

    const error = await caught(laptopSync(fake));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe('conflict');
    expect((error as BackendError).message).toContain(
      'Upgrade to multi-device inventory',
    );
    // The no-force-migration rule: no write of any kind happened.
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('retries a conflict and keeps the racing peer\'s state', async () => {
    const { fake } = arrangePeerRace();

    const result = await laptopSync(fake);

    expect(result.attempts).toBe(2);
    expect(result.version).toBe('v3');

    // The peer's concurrent write survived the retry: both its refreshed
    // state and its newly minted record are still in the final document.
    const final = parseInventoryJsonV2(
      decoder.decode(fake.writeCalls[1]?.data ?? new Uint8Array()),
    );
    expect(final).toEqual(result.document);
    expect(final.devices['phone']).toBeDefined();
    expect(final.devices['laptop']).toBeDefined();
    expect(
      final.extensions['ext-phone']?.stateByDevice['phone']?.version,
    ).toBe('1.1.0');
    expect(
      final.extensions['peer-minted-1']?.stateByDevice['phone'],
    ).toBeDefined();
    // Each attempt redoes the whole merge, minting afresh — the id from the
    // conflicted first attempt ('laptop-minted-1') died with that write, and
    // the id that landed is the second attempt's.
    expect(final.extensions['laptop-minted-1']).toBeUndefined();
    expect(
      final.extensions['laptop-minted-2']?.stateByDevice['laptop'],
    ).toBeDefined();
  });

  it('re-reads on retry and merges against the newer document', async () => {
    const { fake, peerDocument } = arrangePeerRace();

    await laptopSync(fake);

    // One read per attempt.
    expect(fake.readCount).toBe(2);
    expect(fake.writeCalls).toHaveLength(2);
    // First attempt used the stale seed version; the retry used the version
    // the peer's write produced.
    expect(fake.writeCalls[0]?.expectedVersion).toBe('v1');
    expect(fake.writeCalls[1]?.expectedVersion).toBe('v2');
    // The second merge ran against the peer's document (revision '2'), not
    // the stale seed (revision '1'): its output is revision '3' and carries
    // the record only the peer's document contains.
    const retried = parseInventoryJsonV2(
      decoder.decode(fake.writeCalls[1]?.data ?? new Uint8Array()),
    );
    expect(peerDocument.revision).toBe('2');
    expect(retried.revision).toBe('3');
    expect(retried.extensions['peer-minted-1']).toBeDefined();
  });

  it('gives up after maxAttempts conflicts with the conflict error', async () => {
    const fake = new FakeBackend();
    fake.failWritesWith = 'conflict';

    const error = await caught(laptopSync(fake, 3));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe('conflict');
    expect(fake.writeCalls).toHaveLength(3);
    expect(fake.readCount).toBe(3);
  });

  it('does not retry non-conflict errors', async () => {
    const fake = new FakeBackend();
    fake.failWritesWith = 'authentication';

    const error = await caught(laptopSync(fake));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe('authentication');
    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.readCount).toBe(1);
  });

  it('writes bytes that round-trip through the v2 parser', async () => {
    const fake = new FakeBackend();
    fake.seed(serializeInventoryV2(seededRemote()));

    await laptopSync(fake);

    const written = parseInventoryJsonV2(
      decoder.decode(fake.writeCalls[0]?.data ?? new Uint8Array()),
    );
    expect(isInventoryDocumentV2(written)).toBe(true);
  });
});

describe('upgradeRemoteToV2', () => {
  it('lifts a v1 remote, writing with the version it read', async () => {
    const fake = new FakeBackend();
    fake.seed(
      JSON.stringify(
        phoneCapture([
          item('reader@firefox', { browserFamily: 'firefox' }),
          item('other@firefox', { browserFamily: 'firefox' }),
        ]),
      ),
    );

    const result = await upgradeRemoteToV2(fake, {
      newExtensionId: sequentialIds('lifted'),
    });

    expect(result.upgraded).toBe(true);
    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.writeCalls[0]?.expectedVersion).toBe('v1');
    expect(result.version).toBe('v2');

    const written = parseInventoryJsonV2(
      decoder.decode(fake.writeCalls[0]?.data ?? new Uint8Array()),
    );
    expect(isInventoryDocumentV2(written)).toBe(true);
    expect(Object.keys(written.devices)).toEqual(['phone']);
    expect(Object.keys(written.extensions)).toHaveLength(2);
  });

  it('is a no-op on a remote that is already v2', async () => {
    const fake = new FakeBackend();
    const document = seededRemote();
    fake.seed(serializeInventoryV2(document));

    const result = await upgradeRemoteToV2(fake);

    expect(result.upgraded).toBe(false);
    expect(result.version).toBe('v1');
    expect(result.document).toEqual(document);
    expect(fake.writeCalls).toHaveLength(0);
  });

  it('throws not_found for an absent remote', async () => {
    const error = await caught(upgradeRemoteToV2(new FakeBackend()));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe('not_found');
  });

  it('does not retry a conflicting upgrade write', async () => {
    const fake = new FakeBackend();
    fake.seed(JSON.stringify(phoneCapture([item('reader@firefox')])));
    fake.failWritesWith = 'conflict';

    const error = await caught(upgradeRemoteToV2(fake));

    expect(error).toBeInstanceOf(BackendError);
    expect((error as BackendError).code).toBe('conflict');
    expect(fake.writeCalls).toHaveLength(1);
    expect(fake.readCount).toBe(1);
  });
});

describe('readRemoteDocument', () => {
  it('reports an absent remote', async () => {
    await expect(readRemoteDocument(new FakeBackend())).resolves.toEqual({
      kind: 'absent',
    });
  });

  it('recognizes a v1 document', async () => {
    const fake = new FakeBackend();
    const v1 = phoneCapture([item('reader@firefox', { browserFamily: 'firefox' })]);
    fake.seed(JSON.stringify(v1));

    const shape = await readRemoteDocument(fake);

    expect(shape.kind).toBe('v1');
    if (shape.kind !== 'v1') throw new Error('unreachable');
    expect(shape.version).toBe('v1');
    expect(shape.document.device.id).toBe('phone');
  });

  it('recognizes a v2 document', async () => {
    const fake = new FakeBackend();
    fake.seed(serializeInventoryV2(seededRemote()));

    const shape = await readRemoteDocument(fake);

    expect(shape.kind).toBe('v2');
    if (shape.kind !== 'v2') throw new Error('unreachable');
    expect(shape.version).toBe('v1');
    expect(shape.document.revision).toBe('1');
  });

  it('throws InventoryFormatError for malformed JSON', async () => {
    const fake = new FakeBackend();
    fake.seed('{not json');

    const error = await caught(readRemoteDocument(fake));

    expect(error).toBeInstanceOf(InventoryFormatError);
    expect((error as InventoryFormatError).code).toBe('invalid_json');
  });

  it('surfaces the v2 error when both parsers reject', async () => {
    const fake = new FakeBackend();
    fake.seed('{"schemaVersion":3}');

    const error = await caught(readRemoteDocument(fake));

    expect(error).toBeInstanceOf(InventoryFormatError);
    expect((error as InventoryFormatError).code).toBe('unsupported_schema');
    expect((error as InventoryFormatError).message).toContain('3');
  });
});
