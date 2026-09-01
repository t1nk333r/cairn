import { describe, expect, it } from 'vitest';
import { diffInventories } from '../src/core/diff';
import {
  InventoryFormatError,
  isInventoryDocument,
} from '../src/core/inventory';
import type {
  DeviceExtensionState,
  InventoryDocumentV2,
} from '../src/core/inventory-v2';
import { projectDeviceInventory } from '../src/core/inventory-projection';

const CHROMIUM_DEVICE = 'device-chromium';
const FIREFOX_DEVICE = 'device-firefox';

const state = (
  overrides: Partial<DeviceExtensionState> = {},
): DeviceExtensionState => ({
  installed: true,
  enabled: true,
  version: '1.0.0',
  observedAt: '2026-08-30T10:00:00.000Z',
  ...overrides,
});

// Fixture: two devices and four records.
// A — installed and enabled on both devices, aliased in both families.
// B — installed on the Chromium device only.
// C — tombstoned on the Chromium device, installed on the Firefox device.
// D — Firefox-only (no chromium alias), installed on the Firefox device.
const fixture = (): InventoryDocumentV2 => ({
  schemaVersion: 2,
  revision: 'rev-1',
  updatedAt: '2026-08-31T12:00:00.000Z',
  devices: {
    [CHROMIUM_DEVICE]: {
      label: 'Work Laptop',
      browserFamily: 'chromium',
      lastSeenAt: '2026-08-31T11:00:00.000Z',
    },
    [FIREFOX_DEVICE]: {
      label: 'Home Desktop',
      browserFamily: 'firefox',
      lastSeenAt: '2026-08-31T11:30:00.000Z',
    },
  },
  extensions: {
    'ext-a': {
      name: 'uBlock Origin',
      aliases: {
        chromium: ['cjpalhdlnbpafiamejdnhcphjbkeiagm'],
        firefox: ['uBlock0@raymondhill.net'],
      },
      sources: {
        chromium:
          'https://chromewebstore.google.com/detail/cjpalhdlnbpafiamejdnhcphjbkeiagm',
        firefox: 'https://addons.mozilla.org/firefox/addon/ublock-origin/',
      },
      homepageUrl: 'https://github.com/gorhill/uBlock',
      stateByDevice: {
        [CHROMIUM_DEVICE]: state({ version: '1.58.0' }),
        [FIREFOX_DEVICE]: state({ version: '1.57.2' }),
      },
    },
    'ext-b': {
      name: 'Bitwarden',
      aliases: { chromium: ['nngceckbapebfimnlniiiahkandclblb'] },
      stateByDevice: {
        [CHROMIUM_DEVICE]: state({ version: '2026.8.0' }),
      },
    },
    'ext-c': {
      name: 'Dark Reader',
      aliases: {
        chromium: ['eimadpbcbfnmbkopoojfekhnkhdbieeh'],
        firefox: ['addon@darkreader.org'],
      },
      stateByDevice: {
        [CHROMIUM_DEVICE]: state({
          installed: false,
          deletedAt: '2026-08-29T09:00:00.000Z',
        }),
        [FIREFOX_DEVICE]: state({ version: '4.9.80' }),
      },
    },
    'ext-d': {
      name: 'Tree Style Tab',
      aliases: { firefox: ['treestyletab@piro.sakura.ne.jp'] },
      stateByDevice: {
        [FIREFOX_DEVICE]: state({ version: '4.0.19' }),
      },
    },
  },
});

describe('projectDeviceInventory', () => {
  it('projects the Chromium device to exactly A and B, sorted by name', () => {
    const projected = projectDeviceInventory(fixture(), CHROMIUM_DEVICE);
    expect(projected.extensions.map((item) => item.name)).toEqual([
      'Bitwarden',
      'uBlock Origin',
    ]);
  });

  it('projects the Firefox device to exactly A, C, and D', () => {
    const projected = projectDeviceInventory(fixture(), FIREFOX_DEVICE);
    expect(projected.extensions.map((item) => item.name)).toEqual([
      'Dark Reader',
      'Tree Style Tab',
      'uBlock Origin',
    ]);
  });

  it('produces documents indistinguishable from real v1 inventories', () => {
    const document = fixture();
    expect(isInventoryDocument(projectDeviceInventory(document, CHROMIUM_DEVICE))).toBe(
      true,
    );
    expect(isInventoryDocument(projectDeviceInventory(document, FIREFOX_DEVICE))).toBe(
      true,
    );
  });

  it('projects the device record, using the v2 label as browserName', () => {
    const projected = projectDeviceInventory(fixture(), CHROMIUM_DEVICE);
    expect(projected.device).toEqual({
      id: CHROMIUM_DEVICE,
      label: 'Work Laptop',
      browserFamily: 'chromium',
      browserName: 'Work Laptop',
    });
  });

  it('sets generatedAt to the v2 document updatedAt', () => {
    const projected = projectDeviceInventory(fixture(), FIREFOX_DEVICE);
    expect(projected.generatedAt).toBe('2026-08-31T12:00:00.000Z');
  });

  it('excludes tombstoned extensions from the projection', () => {
    const projected = projectDeviceInventory(fixture(), CHROMIUM_DEVICE);
    expect(
      projected.extensions.find((item) => item.name === 'Dark Reader'),
    ).toBeUndefined();
  });

  it("resolves each device's own browser-family alias", () => {
    const document = fixture();
    const chromium = projectDeviceInventory(document, CHROMIUM_DEVICE);
    const firefox = projectDeviceInventory(document, FIREFOX_DEVICE);
    expect(
      chromium.extensions.find((item) => item.name === 'uBlock Origin')?.id,
    ).toBe('cjpalhdlnbpafiamejdnhcphjbkeiagm');
    expect(
      firefox.extensions.find((item) => item.name === 'uBlock Origin')?.id,
    ).toBe('uBlock0@raymondhill.net');
  });

  it('quietly skips records with no alias for the device browser family', () => {
    const chromium = projectDeviceInventory(fixture(), CHROMIUM_DEVICE);
    expect(
      chromium.extensions.find((item) => item.name === 'Tree Style Tab'),
    ).toBeUndefined();
  });

  it('throws InventoryFormatError for an unknown device id', () => {
    let thrown: unknown;
    try {
      projectDeviceInventory(fixture(), 'nope');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InventoryFormatError);
    expect((thrown as InventoryFormatError).code).toBe('invalid_inventory');
  });

  it('composes with the unmodified diffInventories', () => {
    const document = fixture();
    const local = projectDeviceInventory(document, CHROMIUM_DEVICE);
    const remote = projectDeviceInventory(document, FIREFOX_DEVICE);
    const result = diffInventories(local, remote);

    // Cross-family matching is deliberately not implemented yet (tracked in
    // docs/design/inventory-schema-v2.md §3): keyOf includes browserFamily, so
    // A's chromium and firefox projections do not match and A shows up on both
    // sides of the diff alongside the genuine differences B, C, and D.
    expect(result.onlyLocal.map((item) => item.name)).toEqual([
      'Bitwarden',
      'uBlock Origin',
    ]);
    expect(result.onlyRemote.map((item) => item.name)).toEqual([
      'Dark Reader',
      'Tree Style Tab',
      'uBlock Origin',
    ]);
    expect(result.versionChanges).toEqual([]);
    expect(result.stateChanges).toEqual([]);
  });

  it('projects per-device version and enabled state faithfully', () => {
    const document = fixture();
    const shared = document.extensions['ext-a'];
    if (!shared) throw new Error('fixture missing ext-a');
    shared.stateByDevice[FIREFOX_DEVICE] = state({
      version: '1.57.2',
      enabled: false,
    });

    const chromium = projectDeviceInventory(document, CHROMIUM_DEVICE);
    const firefox = projectDeviceInventory(document, FIREFOX_DEVICE);
    const chromiumItem = chromium.extensions.find(
      (item) => item.name === 'uBlock Origin',
    );
    const firefoxItem = firefox.extensions.find(
      (item) => item.name === 'uBlock Origin',
    );

    expect(chromiumItem?.version).toBe('1.58.0');
    expect(firefoxItem?.version).toBe('1.57.2');
    expect(chromiumItem?.enabled).toBe(true);
    expect(firefoxItem?.enabled).toBe(false);
  });

  it('projects a device with no matching records to an empty inventory', () => {
    const document = fixture();
    document.devices['device-empty'] = {
      label: 'Fresh Install',
      browserFamily: 'chromium',
      lastSeenAt: '2026-08-31T11:45:00.000Z',
    };

    const projected = projectDeviceInventory(document, 'device-empty');
    expect(projected.extensions).toEqual([]);
    expect(isInventoryDocument(projected)).toBe(true);
  });
});
