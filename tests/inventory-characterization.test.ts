import { describe, expect, it } from 'vitest';
import {
  captureInventory,
  InventoryFormatError,
  parseInventoryJson,
  serializeInventory,
  type DeviceObservation,
  type ExtensionInventoryItem,
  type InventoryDocument,
  type ManagementExtensionInfo,
} from '../src/core/inventory';

/**
 * These tests pin the CURRENT behavior of `src/core/inventory.ts` (schema
 * v1) so that a future v2 migration can prove it did not silently change
 * what today's clients read and write. Several of the behaviors pinned
 * here are arguably wrong (see the comments on each test). Do not "fix"
 * these tests to make them assert nicer behavior — if one starts failing,
 * the fix belongs in a deliberate, separately-reviewed change, and the
 * test should be updated in the same commit as that change.
 *
 * See docs/design/inventory-schema-v2.md for the schema v2 design that
 * this suite exists to make safe.
 */

const device: DeviceObservation = {
  id: 'device-1',
  label: 'Laptop',
  browserFamily: 'chromium',
  browserName: 'Helium',
};

// Fixture extensions chosen so that:
//   - name order:                 Alpha(4), Bravo(3), Charlie(1), Yankee(5), Zulu(2)
//   - browserFamily:id order:     c-alpha(3), c-charlie(1), c-zulu(5), f-alpha@example.org(2), f-zulu@example.org(4)
// These two orderings are different permutations of the same five items,
// which is exactly the divergence test 1 and test 2 pin.
const fixtureExtensions: ExtensionInventoryItem[] = [
  {
    id: 'c-charlie',
    browserFamily: 'chromium',
    name: 'Charlie',
    version: '1.0.0',
    enabled: true,
    type: 'extension',
    observedAt: '2026-08-30T10:00:00.000Z',
  },
  {
    id: 'f-alpha@example.org',
    browserFamily: 'firefox',
    name: 'Zulu',
    version: '2.0.0',
    enabled: false,
    type: 'extension',
    observedAt: '2026-08-30T10:00:00.000Z',
  },
  {
    id: 'c-alpha',
    browserFamily: 'chromium',
    name: 'Bravo',
    version: '3.0.0',
    enabled: true,
    type: 'extension',
    observedAt: '2026-08-30T10:00:00.000Z',
  },
  {
    id: 'f-zulu@example.org',
    browserFamily: 'firefox',
    name: 'Alpha',
    version: '4.0.0',
    enabled: true,
    type: 'extension',
    observedAt: '2026-08-30T10:00:00.000Z',
  },
  {
    id: 'c-zulu',
    browserFamily: 'chromium',
    name: 'Yankee',
    version: '5.0.0',
    enabled: false,
    type: 'extension',
    observedAt: '2026-08-30T10:00:00.000Z',
  },
];

function buildFixtureDocument(): InventoryDocument {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-30T10:00:00.000Z',
    device,
    extensions: fixtureExtensions,
  };
}

describe('inventory characterization: round trip and canonical order', () => {
  it('1. round trip preserves content byte-for-byte, comparing SERIALIZED forms', () => {
    const doc = buildFixtureDocument();
    const firstSerialized = serializeInventory(doc);

    // Pinned fact: `parseInventoryJson` sorts extensions by name-then-id,
    // while `serializeInventory` re-sorts by `browserFamily:id`. So the
    // in-memory array order legitimately differs between a freshly parsed
    // document and a freshly captured one -- that is why this assertion
    // compares two *serialized* strings rather than two in-memory arrays.
    const roundTripped = parseInventoryJson(firstSerialized);
    const secondSerialized = serializeInventory(roundTripped);

    expect(secondSerialized).toBe(firstSerialized);
  });

  it('parseInventoryJson sorts extensions by name, then id (pinned, not asserted as "correct")', () => {
    const doc = buildFixtureDocument();
    const parsed = parseInventoryJson(serializeInventory(doc));
    expect(parsed.extensions.map((item) => item.name)).toEqual([
      'Alpha',
      'Bravo',
      'Charlie',
      'Yankee',
      'Zulu',
    ]);
  });

  it('2. serializeInventory sorts extensions by "browserFamily:id", ascending', () => {
    const doc = buildFixtureDocument();
    const serialized = serializeInventory(doc);
    const reparsedRaw = JSON.parse(serialized) as InventoryDocument;

    // Chromium sorts before firefox lexicographically, so all chromium
    // entries precede all firefox entries; within a family, ids are
    // ascending. This ordering is independent of, and different from, the
    // name-then-id order that parseInventoryJson produces (see test 1).
    expect(reparsedRaw.extensions.map((item) => item.id)).toEqual([
      'c-alpha',
      'c-charlie',
      'c-zulu',
      'f-alpha@example.org',
      'f-zulu@example.org',
    ]);
  });
});

describe('inventory characterization: schema version handling', () => {
  it('3. rejects schemaVersion 2 with InventoryFormatError("unsupported_schema") -- this is the migration constraint', () => {
    const doc = buildFixtureDocument();
    const v2Payload = JSON.stringify({ ...doc, schemaVersion: 2 });

    // Pinned deliberately: ANY document written with schemaVersion 2 today
    // is rejected outright by every currently-installed v1 client. A v2
    // migration must account for this -- see
    // docs/design/inventory-schema-v2.md, "Migration path".
    expect.assertions(2);
    try {
      parseInventoryJson(v2Payload);
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('unsupported_schema');
    }
  });

  it('4. a document missing schemaVersion entirely falls through to "invalid_inventory"', () => {
    const doc = buildFixtureDocument();
    const { schemaVersion: _omit, ...withoutSchemaVersion } = doc;
    const payload = JSON.stringify(withoutSchemaVersion);

    // Pinned: the unsupported_schema branch only fires when the key is
    // PRESENT and mismatched. When the key is absent entirely,
    // isInventoryDocument's own schemaVersion check fails instead, giving
    // a different error code for what is arguably the same underlying
    // problem (not a document this client can read).
    expect.assertions(2);
    try {
      parseInventoryJson(payload);
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('invalid_inventory');
    }
  });

  it('5. invalid JSON yields "invalid_json"', () => {
    expect.assertions(2);
    try {
      parseInventoryJson('{ this is not json');
    } catch (error) {
      expect(error).toBeInstanceOf(InventoryFormatError);
      expect((error as InventoryFormatError).code).toBe('invalid_json');
    }
  });
});

describe('inventory characterization: known-permissive validation gaps', () => {
  it('6. a non-HTTPS sourceUrl currently parses successfully (known-permissive, tracked separately)', () => {
    const doc = buildFixtureDocument();
    const withInsecureSourceUrl: InventoryDocument = {
      ...doc,
      extensions: doc.extensions.map((item) =>
        item.id === 'c-charlie'
          ? { ...item, sourceUrl: 'http://insecure.example.com/not-https' }
          : item,
      ),
    };

    // Pinned deliberately: isInventoryDocument validates presence/type of
    // id/name/version/enabled/type/observedAt/browserFamily, but it does
    // NOT validate sourceUrl, homepageUrl, or updateUrl at all -- not even
    // that they are strings, let alone that they use HTTPS. This is a real
    // security-relevant gap (a non-HTTPS or attacker-controlled URL can
    // ride through untouched) but tightening it is a deliberate behavior
    // change tracked separately, not something this characterization
    // suite should silently paper over. If that validation is added, this
    // test should start failing and be updated in the same commit as the
    // fix.
    const parsed = parseInventoryJson(serializeInventory(withInsecureSourceUrl));
    const patched = parsed.extensions.find((item) => item.id === 'c-charlie');
    expect(patched?.sourceUrl).toBe('http://insecure.example.com/not-https');
  });
});

describe('inventory characterization: captureInventory self-exclusion', () => {
  const self: ManagementExtensionInfo = {
    id: 'hsync-self-id',
    name: 'Cairn',
    version: '0.1.0',
    enabled: true,
    type: 'extension',
  };

  it('7. omits the extension matching management.getSelf() and omits non-"extension" types', async () => {
    const fixedNow = () => new Date('2026-08-31T09:00:00.000Z');

    const inventory = await captureInventory({
      device,
      now: fixedNow,
      management: {
        getSelf: async () => self,
        getAll: async () => [
          self, // must be excluded: matches getSelf().id
          {
            id: 'theme-id',
            name: 'Some Theme',
            version: '1.0.0',
            enabled: true,
            type: 'theme', // must be excluded: not type "extension"
          },
          {
            id: 'kept-extension-id',
            name: 'Kept Extension',
            version: '1.2.3',
            enabled: true,
            type: 'extension',
          },
        ],
      },
    });

    expect(inventory.extensions.map((item) => item.id)).toEqual(['kept-extension-id']);
    expect(inventory.extensions.some((item) => item.id === self.id)).toBe(false);
    expect(inventory.extensions.some((item) => item.type !== 'extension')).toBe(false);
    expect(inventory.generatedAt).toBe('2026-08-31T09:00:00.000Z');
  });
});
