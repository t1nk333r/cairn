import { describe, expect, it } from 'vitest';
import { InventoryFormatError } from '../src/core/inventory';
import {
  isInventoryDocumentV2,
  parseInventoryJsonV2,
  serializeInventoryV2,
  type InventoryDocumentV2,
} from '../src/core/inventory-v2';

// A valid two-device document modeled on the JSON example in
// `docs/design/inventory-schema-v2.md` section 2: one extension present on
// both devices and aliased across families (with a tombstoned entry on the
// phone), one extension present on a single device.
const fixture = (): InventoryDocumentV2 => ({
  schemaVersion: 2,
  revision: '42',
  updatedAt: '2026-08-31T09:00:00.000Z',
  devices: {
    laptop: {
      label: 'Laptop',
      browserFamily: 'chromium',
      lastSeenAt: '2026-08-31T09:00:00.000Z',
    },
    phone: {
      label: 'Phone (Firefox)',
      browserFamily: 'firefox',
      lastSeenAt: '2026-08-30T21:00:00.000Z',
    },
  },
  extensions: {
    'ext-example': {
      name: 'Example',
      aliases: {
        chromium: [
          'abcdefghijklmnopabcdefghijklmnop',
          'ponmlkjihgfedcbaponmlkjihgfedcba',
        ],
        firefox: ['example@example.org'],
      },
      sources: {
        chromium:
          'https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop',
        firefox: 'https://addons.mozilla.org/firefox/addon/example/',
      },
      homepageUrl: 'https://example.org',
      stateByDevice: {
        laptop: {
          installed: true,
          enabled: true,
          version: '1.2.3',
          observedAt: '2026-08-31T09:00:00.000Z',
        },
        phone: {
          installed: false,
          enabled: false,
          version: '1.1.0',
          observedAt: '2026-08-29T12:00:00.000Z',
          deletedAt: '2026-08-30T21:00:00.000Z',
        },
      },
    },
    'ext-orphan': {
      name: 'Only-on-phone Extension',
      aliases: { firefox: ['orphan@example.org'] },
      sources: {},
      stateByDevice: {
        phone: {
          installed: true,
          enabled: true,
          version: '0.9.0',
          observedAt: '2026-08-30T21:00:00.000Z',
        },
      },
    },
  },
});

// Clone the fixture as loosely-typed JSON and apply a corrupting mutation, so
// each rejection case can describe exactly one defect.
const corrupted = (
  mutate: (doc: Record<string, any>) => void,
): unknown => {
  const doc = JSON.parse(JSON.stringify(fixture())) as Record<string, any>;
  mutate(doc);
  return doc;
};

describe('isInventoryDocumentV2', () => {
  it('accepts the valid two-device fixture', () => {
    expect(isInventoryDocumentV2(fixture())).toBe(true);
  });

  it('rejects schemaVersion 1', () => {
    expect(
      isInventoryDocumentV2(
        corrupted((doc) => {
          doc.schemaVersion = 1;
        }),
      ),
    ).toBe(false);
  });

  it('rejects a device whose browserFamily is not chromium or firefox', () => {
    expect(
      isInventoryDocumentV2(
        corrupted((doc) => {
          doc.devices.laptop.browserFamily = 'safari';
        }),
      ),
    ).toBe(false);
  });

  it('rejects an extension record whose aliases object is empty', () => {
    expect(
      isInventoryDocumentV2(
        corrupted((doc) => {
          doc.extensions['ext-example'].aliases = {};
        }),
      ),
    ).toBe(false);
  });

  it('rejects an extension record whose aliases.chromium is an empty array', () => {
    expect(
      isInventoryDocumentV2(
        corrupted((doc) => {
          doc.extensions['ext-example'].aliases.chromium = [];
        }),
      ),
    ).toBe(false);
  });

  it('rejects a stateByDevice entry missing observedAt', () => {
    expect(
      isInventoryDocumentV2(
        corrupted((doc) => {
          delete doc.extensions['ext-example'].stateByDevice.laptop.observedAt;
        }),
      ),
    ).toBe(false);
  });

  it('rejects a stateByDevice key that is not in the devices map', () => {
    expect(
      isInventoryDocumentV2(
        corrupted((doc) => {
          doc.extensions['ext-orphan'].stateByDevice.tablet = {
            installed: true,
            enabled: true,
            version: '0.9.0',
            observedAt: '2026-08-30T21:00:00.000Z',
          };
        }),
      ),
    ).toBe(false);
  });

  it('rejects null, a string, and an array', () => {
    expect(isInventoryDocumentV2(null)).toBe(false);
    expect(isInventoryDocumentV2('inventory')).toBe(false);
    expect(isInventoryDocumentV2([fixture()])).toBe(false);
  });
});

describe('parseInventoryJsonV2', () => {
  it('parses the serialized fixture back into a deep-equal document', () => {
    expect(parseInventoryJsonV2(serializeInventoryV2(fixture()))).toEqual(
      fixture(),
    );
  });

  it('throws invalid_json on malformed JSON', () => {
    expect.assertions(2);
    try {
      parseInventoryJsonV2('{');
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('invalid_json');
    }
  });

  it('throws unsupported_schema on a v1 document', () => {
    // Mirror image of the v1 behavior pinned in
    // tests/inventory-characterization.test.ts: v1 rejects schemaVersion 2,
    // v2 rejects schemaVersion 1.
    expect.assertions(3);
    try {
      parseInventoryJsonV2(
        JSON.stringify(corrupted((doc) => {
          doc.schemaVersion = 1;
        })),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('unsupported_schema');
      expect((error as InventoryFormatError).message).toBe(
        'This inventory uses unsupported schema version 1.',
      );
    }
  });

  it('throws invalid_inventory on a bare schemaVersion 2 object', () => {
    expect.assertions(2);
    try {
      parseInventoryJsonV2('{"schemaVersion":2}');
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('invalid_inventory');
    }
  });
});

describe('serializeInventoryV2', () => {
  it('ends with exactly one newline and uses two-space indentation', () => {
    const output = serializeInventoryV2(fixture());
    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
    expect(output).toContain('\n  "schemaVersion": 2,\n');
    expect(output).toContain('\n    "laptop": {\n');
  });

  it('is deterministic regardless of key insertion order', () => {
    const base = fixture();
    const laptop = base.devices.laptop;
    const phone = base.devices.phone;
    const example = base.extensions['ext-example'];
    const orphan = base.extensions['ext-orphan'];
    if (!laptop || !phone || !example || !orphan) {
      throw new Error('fixture is missing expected keys');
    }

    const forward: InventoryDocumentV2 = {
      schemaVersion: 2,
      revision: base.revision,
      updatedAt: base.updatedAt,
      devices: { laptop, phone },
      extensions: { 'ext-example': example, 'ext-orphan': orphan },
    };
    const reversed: InventoryDocumentV2 = {
      schemaVersion: 2,
      revision: base.revision,
      updatedAt: base.updatedAt,
      devices: { phone, laptop },
      extensions: {
        'ext-orphan': orphan,
        'ext-example': {
          ...example,
          // Reverse the nested maps and alias arrays too.
          aliases: {
            firefox: [...(example.aliases.firefox ?? [])].reverse(),
            chromium: [...(example.aliases.chromium ?? [])].reverse(),
          },
          stateByDevice: Object.fromEntries(
            Object.entries(example.stateByDevice).reverse(),
          ),
        },
      },
    };

    expect(serializeInventoryV2(forward)).toBe(serializeInventoryV2(reversed));
  });

  it('round-trips through parseInventoryJsonV2', () => {
    const original = fixture();
    expect(parseInventoryJsonV2(serializeInventoryV2(original))).toEqual(
      original,
    );
  });
});
