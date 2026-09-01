import { describe, expect, it } from 'vitest';
import type { ExtensionInventoryItem, InventoryDocument } from '../src/core/inventory';
import { liftV1ToV2 } from '../src/core/inventory-migration';
import {
  isInventoryDocumentV2,
  parseInventoryJsonV2,
  serializeInventoryV2,
} from '../src/core/inventory-v2';

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
  observedAt: '2026-08-30T10:00:00.000Z',
  ...overrides,
});

const document = (extensions: ExtensionInventoryItem[]): InventoryDocument => ({
  schemaVersion: 1,
  generatedAt: '2026-08-30T12:00:00.000Z',
  device: {
    id: 'device-1',
    label: 'Work laptop',
    browserFamily: 'chromium',
    browserName: 'Chromium',
  },
  extensions,
});

const fixture = (): InventoryDocument =>
  document([
    item('with-source', {
      sourceUrl: 'https://chromewebstore.google.com/detail/with-source',
      homepageUrl: 'https://example.com/with-source',
    }),
    item('bare', { observedAt: '2026-08-29T08:30:00.000Z' }),
    item('disabled', { enabled: false }),
  ]);

const sequentialIds = () => {
  let n = 0;
  return () => `ext-${++n}`;
};

describe('liftV1ToV2', () => {
  it('produces the v2 document shape', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    expect(result.schemaVersion).toBe(2);
    expect(result.revision).toBe('1');
    expect(result.updatedAt).toBe('2026-08-30T12:00:00.000Z');
  });

  it('produces a document that validates as v2', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    expect(isInventoryDocumentV2(result)).toBe(true);
  });

  it('lifts the single v1 device', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    expect(Object.keys(result.devices)).toEqual(['device-1']);
    const record = result.devices['device-1'];
    expect(record?.label).toBe('Work laptop');
    expect(record?.browserFamily).toBe('chromium');
    expect(record?.lastSeenAt).toBe('2026-08-30T12:00:00.000Z');
  });

  it('drops browserName from the device record', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    const record = result.devices['device-1'];
    expect(record).toBeDefined();
    expect('browserName' in (record ?? {})).toBe(false);
  });

  it('creates one record per v1 extension, keyed by minted ids', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    expect(Object.keys(result.extensions)).toEqual(['ext-1', 'ext-2', 'ext-3']);
  });

  it('records the v1 id as an alias for its browser family only', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    const record = result.extensions['ext-1'];
    expect(record?.aliases.chromium).toEqual(['with-source']);
    expect('firefox' in (record?.aliases ?? {})).toBe(false);
  });

  it('carries sourceUrl into sources and omits sources when absent', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    expect(result.extensions['ext-1']?.sources).toEqual({
      chromium: 'https://chromewebstore.google.com/detail/with-source',
    });
    const bare = result.extensions['ext-2'];
    expect(bare).toBeDefined();
    expect('sources' in (bare ?? {})).toBe(false);
    expect('homepageUrl' in (bare ?? {})).toBe(false);
  });

  it('lifts per-device state, preserving observedAt from v1', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    const states = Object.values(result.extensions).map(
      (record) => record.stateByDevice['device-1'],
    );
    expect(states).toHaveLength(3);
    for (const state of states) {
      expect(state?.installed).toBe(true);
      expect(state?.version).toBe('1.0.0');
    }
    expect(result.extensions['ext-1']?.stateByDevice['device-1']?.enabled).toBe(
      true,
    );
    expect(result.extensions['ext-3']?.stateByDevice['device-1']?.enabled).toBe(
      false,
    );
    // observedAt is carried through from v1, not regenerated.
    expect(
      result.extensions['ext-1']?.stateByDevice['device-1']?.observedAt,
    ).toBe('2026-08-30T10:00:00.000Z');
    expect(
      result.extensions['ext-2']?.stateByDevice['device-1']?.observedAt,
    ).toBe('2026-08-29T08:30:00.000Z');
  });

  it('produces no tombstones', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    for (const record of Object.values(result.extensions)) {
      for (const state of Object.values(record.stateByDevice)) {
        expect('deletedAt' in state).toBe(false);
      }
    }
  });

  it('lifts an empty inventory to a valid v2 document', () => {
    const result = liftV1ToV2(document([]), { newExtensionId: sequentialIds() });
    expect(isInventoryDocumentV2(result)).toBe(true);
    expect(Object.keys(result.devices)).toEqual(['device-1']);
    expect(result.extensions).toEqual({});
  });

  it('survives a serialize/parse round trip', () => {
    const result = liftV1ToV2(fixture(), { newExtensionId: sequentialIds() });
    expect(parseInventoryJsonV2(serializeInventoryV2(result))).toEqual(result);
  });

  it('mints distinct non-empty ids with the default generator', () => {
    const result = liftV1ToV2(fixture());
    const ids = Object.keys(result.extensions);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    }
  });
});
