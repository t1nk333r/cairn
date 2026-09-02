import { describe, expect, it } from 'vitest';
import {
  InventoryFormatError,
  parseInventoryJson,
  serializeInventory,
  type InventoryDocument,
} from '../src/core/inventory';

const validInventory: InventoryDocument = {
  schemaVersion: 1,
  generatedAt: '2026-08-30T10:00:00.000Z',
  device: {
    id: 'device-1',
    label: 'Firefox laptop',
    browserFamily: 'firefox',
    browserName: 'Firefox',
  },
  extensions: [
    {
      id: 'addon@example.org',
      browserFamily: 'firefox',
      name: 'Example',
      version: '1.0.0',
      enabled: true,
      type: 'extension',
      observedAt: '2026-08-30T10:00:00.000Z',
    },
  ],
};

describe('inventory import and export', () => {
  it('round-trips a canonical inventory', () => {
    expect(parseInventoryJson(serializeInventory(validInventory))).toEqual(validInventory);
  });

  it('rejects malformed JSON with a stable error code', () => {
    expect.assertions(2);
    try {
      parseInventoryJson('{ nope');
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('invalid_json');
    }
  });

  it('rejects unsupported future schemas', () => {
    expect(() =>
      parseInventoryJson(JSON.stringify({ ...validInventory, schemaVersion: 99 })),
    ).toThrow('unsupported schema version 99');
  });

  it('rejects structurally invalid inventory documents', () => {
    expect(() =>
      parseInventoryJson(JSON.stringify({ ...validInventory, extensions: [{}] })),
    ).toThrow('not a valid Cairn inventory');
  });
});

