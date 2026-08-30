import { describe, expect, it } from 'vitest';
import {
  captureInventory,
  isInventoryDocument,
  serializeInventory,
  type DeviceObservation,
  type ManagementExtensionInfo,
} from '../src/core/inventory';

const device: DeviceObservation = {
  id: 'device-1',
  label: 'Laptop',
  browserFamily: 'chromium',
  browserName: 'Helium',
};

const self: ManagementExtensionInfo = {
  id: 'hsync-id',
  name: 'hsync',
  version: '0.1.0',
  enabled: true,
  type: 'extension',
};

describe('captureInventory', () => {
  it('excludes itself and non-extension items while sorting extensions', async () => {
    const inventory = await captureInventory({
      device,
      now: () => new Date('2026-08-30T10:00:00.000Z'),
      management: {
        getSelf: async () => self,
        getAll: async () => [
          self,
          { id: 'theme', name: 'Theme', version: '1', enabled: true, type: 'theme' },
          { id: 'bbbb', name: 'Zulu', version: '2', enabled: false, type: 'extension' },
          { id: 'aaaa', name: 'Alpha', version: '1', enabled: true, type: 'extension' },
        ],
      },
    });

    expect(inventory.extensions.map((item) => item.name)).toEqual(['Alpha', 'Zulu']);
    expect(inventory.generatedAt).toBe('2026-08-30T10:00:00.000Z');
    expect(isInventoryDocument(inventory)).toBe(true);
  });

  it('serializes extension order deterministically', async () => {
    const inventory = await captureInventory({
      device,
      management: {
        getSelf: async () => self,
        getAll: async () => [
          { id: 'z', name: 'Alpha', version: '1', enabled: true, type: 'extension' },
          { id: 'a', name: 'Zulu', version: '1', enabled: true, type: 'extension' },
        ],
      },
    });
    const serialized = serializeInventory(inventory);
    expect(serialized.indexOf('"id": "a"')).toBeLessThan(serialized.indexOf('"id": "z"'));
    expect(serialized.endsWith('\n')).toBe(true);
  });
});

