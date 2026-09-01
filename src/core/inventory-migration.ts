// Lifts a v1 single-device inventory document into the v2 multi-device shape.
// Implements "Lifting a v1 remote to v2" (`docs/design/inventory-schema-v2.md`
// §5). Pure and side-effect free: nothing calls this yet — the "Upgrade to
// multi-device inventory" action is a later plan. There is deliberately no
// downgrade path (§5).
import type {
  BrowserFamily,
  ExtensionInventoryItem,
  InventoryDocument,
} from './inventory';
import {
  INVENTORY_SCHEMA_VERSION_V2,
  type ExtensionRecord,
  type InventoryDocumentV2,
} from './inventory-v2';

export interface LiftV1ToV2Options {
  /** Mints a fresh portable extension id. Injectable for deterministic tests. */
  newExtensionId?: () => string;
}

function liftExtension(
  item: ExtensionInventoryItem,
  deviceId: string,
): ExtensionRecord {
  const aliases: Partial<Record<BrowserFamily, string[]>> = {
    [item.browserFamily]: [item.id],
  };
  // v1 fields intentionally not carried across: `browserName`, `type`,
  // `installType`, `updateUrl` — v2's `ExtensionRecord` has no home for them.
  return {
    name: item.name,
    aliases,
    ...(item.sourceUrl !== undefined && item.sourceUrl !== ''
      ? { sources: { [item.browserFamily]: item.sourceUrl } }
      : {}),
    ...(item.homepageUrl !== undefined
      ? { homepageUrl: item.homepageUrl }
      : {}),
    stateByDevice: {
      [deviceId]: {
        // A v1 document only lists extensions that were installed at capture
        // time, and a lift produces no tombstones.
        installed: true,
        enabled: item.enabled,
        version: item.version,
        // Carried through from v1 — regenerating this would fabricate
        // observation history.
        observedAt: item.observedAt,
      },
    },
  };
}

export function liftV1ToV2(
  document: InventoryDocument,
  options?: LiftV1ToV2Options,
): InventoryDocumentV2 {
  const newExtensionId =
    options?.newExtensionId ?? (() => crypto.randomUUID());
  const deviceId = document.device.id;
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION_V2,
    // A lifted document is the first revision of its v2 history.
    revision: '1',
    updatedAt: document.generatedAt,
    devices: {
      [deviceId]: {
        label: document.device.label,
        browserFamily: document.device.browserFamily,
        lastSeenAt: document.generatedAt,
      },
    },
    extensions: Object.fromEntries(
      document.extensions.map((item) => [
        newExtensionId(),
        liftExtension(item, deviceId),
      ]),
    ),
  };
}
