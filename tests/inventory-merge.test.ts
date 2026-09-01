import { describe, expect, it } from 'vitest';
import type {
  ExtensionInventoryItem,
  InventoryDocument,
} from '../src/core/inventory';
import { mergeLocalObservation } from '../src/core/inventory-merge';
import { liftV1ToV2 } from '../src/core/inventory-migration';
import {
  isInventoryDocumentV2,
  type DeviceExtensionState,
  type InventoryDocumentV2,
} from '../src/core/inventory-v2';

const T0 = '2026-08-30T10:00:00.000Z';
const NOW = '2026-09-01T12:00:00.000Z';
const LATER = '2026-09-02T09:30:00.000Z';

const at = (iso: string) => () => new Date(iso);

const sequentialIds = (prefix = 'minted') => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const state = (
  overrides: Partial<DeviceExtensionState> = {},
): DeviceExtensionState => ({
  installed: true,
  enabled: true,
  version: '1.0.0',
  observedAt: T0,
  ...overrides,
});

// Two-device union fixture: `laptop` (chromium) and `phone` (firefox), with
// one extension observed by both devices, one by laptop only, and one by
// phone only.
const remoteFixture = (): InventoryDocumentV2 => ({
  schemaVersion: 2,
  revision: '7',
  updatedAt: T0,
  devices: {
    laptop: { label: 'Laptop', browserFamily: 'chromium', lastSeenAt: T0 },
    phone: { label: 'Phone', browserFamily: 'firefox', lastSeenAt: T0 },
  },
  extensions: {
    'ext-both': {
      name: 'Both Devices',
      aliases: { chromium: ['both-chromium-id'], firefox: ['both@firefox'] },
      stateByDevice: {
        laptop: state({ version: '2.0.0' }),
        phone: state({ version: '2.1.0', enabled: false }),
      },
    },
    'ext-laptop-only': {
      name: 'Laptop Only',
      aliases: { chromium: ['laptop-only-id'] },
      sources: {
        chromium: 'https://chromewebstore.google.com/detail/laptop-only-id',
      },
      homepageUrl: 'https://example.com/laptop-only',
      stateByDevice: { laptop: state({ version: '3.3.0' }) },
    },
    'ext-phone-only': {
      name: 'Phone Only',
      aliases: { firefox: ['phone-only@firefox'] },
      stateByDevice: { phone: state() },
    },
  },
});

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
  observedAt: T0,
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
  generatedAt: NOW,
  device: {
    id: 'phone',
    label: 'Phone',
    browserFamily: 'firefox',
    browserName: 'Firefox',
  },
  extensions,
});

const merge = (
  remote: InventoryDocumentV2,
  local: InventoryDocument,
): InventoryDocumentV2 =>
  mergeLocalObservation({
    remote,
    local,
    now: at(NOW),
    newExtensionId: sequentialIds(),
  });

describe('mergeLocalObservation', () => {
  // Case 1
  it('updates the existing record on an exact alias match without creating a second record', () => {
    const remote = remoteFixture();
    const result = merge(
      remote,
      laptopCapture([
        item('both-chromium-id', { version: '2.5.0', enabled: false }),
      ]),
    );
    expect(Object.keys(result.extensions).sort()).toEqual(
      Object.keys(remote.extensions).sort(),
    );
    expect(result.extensions['ext-both']?.stateByDevice['laptop']).toEqual({
      installed: true,
      enabled: false,
      version: '2.5.0',
      observedAt: NOW,
    });
  });

  // Case 2
  it('mints exactly one new record for an id no alias matches', () => {
    const remote = remoteFixture();
    const result = merge(
      remote,
      laptopCapture([
        item('both-chromium-id'),
        item('brand-new-id', { name: 'Brand New' }),
      ]),
    );
    expect(Object.keys(result.extensions)).toHaveLength(
      Object.keys(remote.extensions).length + 1,
    );
    expect(result.extensions['minted-1']).toEqual({
      name: 'Brand New',
      aliases: { chromium: ['brand-new-id'] },
      stateByDevice: {
        laptop: {
          installed: true,
          enabled: true,
          version: '1.0.0',
          observedAt: NOW,
        },
      },
    });
  });

  // Case 3
  it('carries sources and homepageUrl onto a new record only when present', () => {
    const result = merge(
      remoteFixture(),
      laptopCapture([
        item('with-urls', {
          sourceUrl: 'https://chromewebstore.google.com/detail/with-urls',
          homepageUrl: 'https://example.com/with-urls',
        }),
        item('bare-new'),
        item('empty-source', { sourceUrl: '' }),
      ]),
    );
    const withUrls = result.extensions['minted-1'];
    expect(withUrls?.sources).toEqual({
      chromium: 'https://chromewebstore.google.com/detail/with-urls',
    });
    expect(withUrls?.homepageUrl).toBe('https://example.com/with-urls');

    const bare = result.extensions['minted-2'];
    expect(bare).toBeDefined();
    expect('sources' in (bare ?? {})).toBe(false);
    expect('homepageUrl' in (bare ?? {})).toBe(false);

    const emptySource = result.extensions['minted-3'];
    expect(emptySource).toBeDefined();
    expect('sources' in (emptySource ?? {})).toBe(false);
  });

  // Case 4 — THE CRITICAL CASE
  it("never touches another device's stateByDevice entries, across all records", () => {
    const remote = remoteFixture();
    const pristine = structuredClone(remote);
    const result = merge(
      remote,
      laptopCapture([
        item('both-chromium-id', { version: '9.9.9' }),
        item('fresh-id'),
      ]),
    );
    let phoneEntriesChecked = 0;
    for (const [portableId, record] of Object.entries(pristine.extensions)) {
      const phoneState = record.stateByDevice['phone'];
      if (phoneState !== undefined) {
        phoneEntriesChecked += 1;
        expect(result.extensions[portableId]?.stateByDevice['phone']).toEqual(
          phoneState,
        );
      }
    }
    expect(phoneEntriesChecked).toBe(2);
  });

  // Case 5
  it("leaves another device's DeviceRecord untouched", () => {
    const remote = remoteFixture();
    const pristine = structuredClone(remote);
    const result = merge(remote, laptopCapture([item('both-chromium-id')]));
    expect(result.devices['phone']).toEqual(pristine.devices['phone']);
  });

  // Case 6
  it('tombstones its own entry for an extension absent from the capture', () => {
    const result = merge(remoteFixture(), laptopCapture([item('both-chromium-id')]));
    expect(
      result.extensions['ext-laptop-only']?.stateByDevice['laptop'],
    ).toEqual({
      installed: false,
      enabled: false,
      version: '3.3.0',
      observedAt: NOW,
      deletedAt: NOW,
    });
  });

  // Case 7
  it('tombstones are per-device: the other device still reads installed', () => {
    const result = merge(remoteFixture(), laptopCapture([]));
    expect(
      result.extensions['ext-both']?.stateByDevice['laptop']?.installed,
    ).toBe(false);
    expect(result.extensions['ext-both']?.stateByDevice['phone']).toEqual(
      state({ version: '2.1.0', enabled: false }),
    );
  });

  // Case 8
  it('does not refresh an existing tombstone on a later merge', () => {
    const first = merge(remoteFixture(), laptopCapture([item('both-chromium-id')]));
    const second = mergeLocalObservation({
      remote: first,
      local: laptopCapture([item('both-chromium-id')]),
      now: at(LATER),
      newExtensionId: sequentialIds('second'),
    });
    expect(
      second.extensions['ext-laptop-only']?.stateByDevice['laptop'],
    ).toEqual({
      installed: false,
      enabled: false,
      version: '3.3.0',
      observedAt: NOW,
      deletedAt: NOW,
    });
  });

  // Case 9
  it('clears the tombstone when the extension is observed again', () => {
    const first = merge(remoteFixture(), laptopCapture([item('both-chromium-id')]));
    const second = mergeLocalObservation({
      remote: first,
      local: laptopCapture([
        item('both-chromium-id'),
        item('laptop-only-id', { version: '3.4.0' }),
      ]),
      now: at(LATER),
      newExtensionId: sequentialIds('second'),
    });
    const reinstalled =
      second.extensions['ext-laptop-only']?.stateByDevice['laptop'];
    expect(reinstalled).toEqual({
      installed: true,
      enabled: true,
      version: '3.4.0',
      observedAt: LATER,
    });
    expect(reinstalled !== undefined && 'deletedAt' in reinstalled).toBe(false);
  });

  // Case 10
  it('leaves a record this device never saw completely alone', () => {
    const remote = remoteFixture();
    const pristine = structuredClone(remote);
    const result = merge(
      remote,
      laptopCapture([item('both-chromium-id'), item('laptop-only-id')]),
    );
    expect(result.extensions['ext-phone-only']).toEqual(
      pristine.extensions['ext-phone-only'],
    );
    expect(
      'laptop' in (result.extensions['ext-phone-only']?.stateByDevice ?? {}),
    ).toBe(false);
  });

  // Case 11
  it('updates its own device record, updatedAt, and revision', () => {
    const result = merge(remoteFixture(), laptopCapture([item('both-chromium-id')]));
    expect(result.devices['laptop']).toEqual({
      label: 'Laptop',
      browserFamily: 'chromium',
      lastSeenAt: NOW,
    });
    expect(result.updatedAt).toBe(NOW);
    expect(result.revision).toBe('8');

    const corrupted = { ...remoteFixture(), revision: 'not-a-number' };
    expect(merge(corrupted, laptopCapture([])).revision).toBe('1');
  });

  // Case 12
  it('does not mutate its input', () => {
    const remote = remoteFixture();
    const clone = structuredClone(remote);
    merge(
      remote,
      laptopCapture([
        item('both-chromium-id', { version: '5.0.0' }),
        item('never-seen-before'),
      ]),
    );
    expect(remote).toEqual(clone);
  });

  // Case 13
  it('produces a document that validates as v2', () => {
    const result = merge(
      remoteFixture(),
      laptopCapture([item('both-chromium-id'), item('never-seen-before')]),
    );
    expect(isInventoryDocumentV2(result)).toBe(true);
  });

  // Case 14 — THE REGRESSION TEST FOR THE ACTUAL BUG
  it("a stale device cannot resurrect another device's removal", () => {
    const start = remoteFixture();
    // Step 1: phone removes "Both Devices" — its fresh capture no longer
    // contains it, so phone's merge writes a phone tombstone.
    const afterPhoneRemoval = mergeLocalObservation({
      remote: start,
      local: phoneCapture([
        item('phone-only@firefox', { browserFamily: 'firefox' }),
      ]),
      now: at(NOW),
      newExtensionId: sequentialIds('phone'),
    });
    const phoneTombstone =
      afterPhoneRemoval.extensions['ext-both']?.stateByDevice['phone'];
    expect(phoneTombstone).toEqual({
      installed: false,
      enabled: false,
      version: '2.1.0',
      observedAt: NOW,
      deletedAt: NOW,
    });

    // Step 2: laptop, whose local view is stale and still includes the
    // extension, merges against phone's result. Under v1 this whole-document
    // overwrite silently undid phone's deletion.
    const afterStaleLaptop = mergeLocalObservation({
      remote: afterPhoneRemoval,
      local: laptopCapture([
        item('both-chromium-id', { version: '2.0.0' }),
        item('laptop-only-id', { version: '3.3.0' }),
      ]),
      now: at(LATER),
      newExtensionId: sequentialIds('laptop'),
    });
    expect(
      afterStaleLaptop.extensions['ext-both']?.stateByDevice['phone'],
    ).toEqual(phoneTombstone);
    expect(
      afterStaleLaptop.extensions['ext-both']?.stateByDevice['laptop']
        ?.installed,
    ).toBe(true);
  });

  // Case 15
  it('an empty capture tombstones only its own installed entries', () => {
    const remote = remoteFixture();
    const pristine = structuredClone(remote);
    const result = merge(remote, laptopCapture([]));
    expect(result.extensions['ext-both']?.stateByDevice['laptop']).toEqual({
      installed: false,
      enabled: false,
      version: '2.0.0',
      observedAt: NOW,
      deletedAt: NOW,
    });
    expect(
      result.extensions['ext-laptop-only']?.stateByDevice['laptop'],
    ).toEqual({
      installed: false,
      enabled: false,
      version: '3.3.0',
      observedAt: NOW,
      deletedAt: NOW,
    });
    // Nothing else moves.
    expect(Object.keys(result.extensions).sort()).toEqual(
      Object.keys(pristine.extensions).sort(),
    );
    expect(result.extensions['ext-phone-only']).toEqual(
      pristine.extensions['ext-phone-only'],
    );
    expect(result.extensions['ext-both']?.stateByDevice['phone']).toEqual(
      pristine.extensions['ext-both']?.stateByDevice['phone'],
    );
    expect(result.devices['phone']).toEqual(pristine.devices['phone']);
  });

  // Case 16
  it('merging into an empty remote is shape-equivalent to a v1 lift', () => {
    const emptyRemote: InventoryDocumentV2 = {
      schemaVersion: 2,
      revision: '0',
      updatedAt: T0,
      devices: {},
      extensions: {},
    };
    const local = laptopCapture([
      item('alpha', { observedAt: NOW }),
      item('beta', {
        observedAt: NOW,
        sourceUrl: 'https://chromewebstore.google.com/detail/beta',
        homepageUrl: 'https://example.com/beta',
      }),
    ]);
    const result = mergeLocalObservation({
      remote: emptyRemote,
      local,
      now: at(NOW),
      newExtensionId: sequentialIds('merge'),
    });
    expect(isInventoryDocumentV2(result)).toBe(true);
    expect(result.revision).toBe('1');

    // Ids are minted independently, so compare everything but the keys.
    const lifted = liftV1ToV2(local, { newExtensionId: sequentialIds('lift') });
    expect(result.devices).toEqual(lifted.devices);
    expect(Object.values(result.extensions)).toEqual(
      Object.values(lifted.extensions),
    );
  });
});
