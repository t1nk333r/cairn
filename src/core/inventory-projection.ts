// Projects one device's view out of a v2 multi-device inventory document,
// materializing it in the flat v1 `InventoryDocument` shape. This lets the
// existing `diffInventories` in `./diff` be reused unchanged when the app
// starts reading v2 documents. See `docs/design/inventory-schema-v2.md`
// §5 "Files that change".
import {
  INVENTORY_SCHEMA_VERSION,
  InventoryFormatError,
  type ExtensionInventoryItem,
  type InventoryDocument,
} from './inventory';
import type { InventoryDocumentV2 } from './inventory-v2';

export function projectDeviceInventory(
  document: InventoryDocumentV2,
  deviceId: string,
): InventoryDocument {
  const deviceRecord = document.devices[deviceId];
  if (deviceRecord === undefined) {
    throw new InventoryFormatError(
      'invalid_inventory',
      `Unknown device ${deviceId}.`,
    );
  }

  const { browserFamily } = deviceRecord;
  const extensions: ExtensionInventoryItem[] = [];

  for (const [, record] of Object.entries(document.extensions)) {
    const state = record.stateByDevice[deviceId];
    // No state entry: this device has never seen the extension. Not installed
    // or tombstoned: the extension is absent on this device, and must project
    // to absent — not to a disabled item.
    if (state === undefined) continue;
    if (state.installed === false) continue;
    if (state.deletedAt !== undefined) continue;

    // A record with no alias for this device's browser family cannot be
    // represented as a v1 item; skipping quietly is the ordinary cross-family
    // case (e.g. a Firefox-only extension projected for a Chromium device),
    // not corruption.
    const alias = record.aliases[browserFamily]?.[0];
    if (alias === undefined) continue;

    const sourceUrl = record.sources?.[browserFamily];
    extensions.push({
      id: alias,
      browserFamily,
      name: record.name,
      version: state.version,
      enabled: state.enabled,
      type: 'extension',
      ...(sourceUrl !== undefined ? { sourceUrl } : {}),
      ...(record.homepageUrl !== undefined
        ? { homepageUrl: record.homepageUrl }
        : {}),
      observedAt: state.observedAt,
    });
  }

  extensions.sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );

  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: document.updatedAt,
    device: {
      id: deviceId,
      label: deviceRecord.label,
      browserFamily,
      browserName: deviceRecord.label,
    },
    extensions,
  };
}
