// Folds one device's fresh local observations into the shared v2 union
// document. Implements steps 1–4 of "Producing a local update"
// (`docs/design/inventory-schema-v2.md` §4) as a pure function; the backend
// write with `expectedVersion` (step 5) and its conflict retry are plan 012.
//
// Central invariant: every write is keyed by the merging device's own id. The
// merge never rewrites another device's `stateByDevice` entry, never touches
// another device's `DeviceRecord`, and never removes a map entry — it only
// adds or tombstones. Pruning is a separate, user-confirmed action.
//
// Identity resolution implements only step 1 of the §3 ladder: an exact
// browser-family alias match wins; otherwise a new record is minted. Steps
// 2–4 (user-confirmed aliases, URL proposals, name suggestions) are
// user-driven and are deliberately absent — records are never linked
// automatically.
import type {
  BrowserFamily,
  InventoryDocument,
} from './inventory';
import {
  INVENTORY_SCHEMA_VERSION_V2,
  type DeviceExtensionState,
  type ExtensionRecord,
  type InventoryDocumentV2,
} from './inventory-v2';

export interface MergeLocalObservationInput {
  /** The union document as most recently fetched from the backend. */
  remote: InventoryDocumentV2;
  /** This device's fresh capture, straight from `captureInventory`. */
  local: InventoryDocument;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  /** Mints portable ids for extensions no record matches. Injectable for tests. */
  newExtensionId?: () => string;
}

function nextRevision(revision: string): string {
  const parsed = Number(revision);
  // A non-numeric revision means a foreign or corrupted writer; recovering to
  // a usable counter beats throwing — the backend's own `version` token is
  // what actually protects the write.
  const current =
    Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  return String(current + 1);
}

export function mergeLocalObservation(
  input: MergeLocalObservationInput,
): InventoryDocumentV2 {
  const { remote, local } = input;
  const now = input.now ?? (() => new Date());
  const newExtensionId = input.newExtensionId ?? (() => crypto.randomUUID());
  const timestamp = now().toISOString();
  const deviceId = local.device.id;
  const browserFamily = local.device.browserFamily;

  // Identity ladder step 1: exact browser-family alias match. If the same
  // browser id somehow appears under two portable ids the document is
  // malformed; prefer the first in iteration order rather than throwing, so
  // the observation is not lost.
  const portableIdByAlias = new Map<string, string>();
  for (const [portableId, record] of Object.entries(remote.extensions)) {
    for (const alias of record.aliases[browserFamily] ?? []) {
      if (!portableIdByAlias.has(alias)) {
        portableIdByAlias.set(alias, portableId);
      }
    }
  }

  // §4 step 1: resolve each fresh observation to a portable id (or mint one)
  // and prepare this device's own `stateByDevice` entry. Deliberately no
  // `deletedAt` key — a re-installed extension's tombstone must disappear,
  // not linger.
  const observedIds = new Set<string>();
  const freshStateByPortableId = new Map<string, DeviceExtensionState>();
  const mintedRecords: Array<[string, ExtensionRecord]> = [];

  for (const item of local.extensions) {
    const state: DeviceExtensionState = {
      installed: true,
      enabled: item.enabled,
      version: item.version,
      observedAt: timestamp,
    };
    const matchedId = portableIdByAlias.get(item.id);
    if (matchedId !== undefined) {
      observedIds.add(matchedId);
      freshStateByPortableId.set(matchedId, state);
      continue;
    }
    // No match anywhere: mint a new record, shaped exactly as `liftV1ToV2`
    // builds one.
    const portableId = newExtensionId();
    observedIds.add(portableId);
    const aliases: Partial<Record<BrowserFamily, string[]>> = {
      [browserFamily]: [item.id],
    };
    mintedRecords.push([
      portableId,
      {
        name: item.name,
        aliases,
        ...(item.sourceUrl !== undefined && item.sourceUrl !== ''
          ? { sources: { [browserFamily]: item.sourceUrl } }
          : {}),
        ...(item.homepageUrl !== undefined
          ? { homepageUrl: item.homepageUrl }
          : {}),
        stateByDevice: { [deviceId]: state },
      },
    ]);
  }

  const extensions: Record<string, ExtensionRecord> = {};
  for (const [portableId, record] of Object.entries(remote.extensions)) {
    const freshState = freshStateByPortableId.get(portableId);
    if (freshState !== undefined) {
      // Matched an existing record: keep its `name`, `aliases`, `sources`,
      // and `homepageUrl` as they are — this device does not get to rename or
      // re-source another device's record — and overwrite only this device's
      // own entry.
      extensions[portableId] = {
        ...record,
        stateByDevice: {
          ...record.stateByDevice,
          [deviceId]: freshState,
        },
      };
      continue;
    }

    // §4 step 2: tombstone this device's own entry when it was installed but
    // was not observed this cycle. This is the only way a `deletedAt` is ever
    // set. An entry that is missing or already tombstoned is left completely
    // alone — no timestamp refresh.
    const existing = record.stateByDevice[deviceId];
    if (existing !== undefined && existing.installed) {
      extensions[portableId] = {
        ...record,
        stateByDevice: {
          ...record.stateByDevice,
          [deviceId]: {
            installed: false,
            enabled: false,
            version: existing.version,
            observedAt: timestamp,
            deletedAt: timestamp,
          },
        },
      };
      continue;
    }

    extensions[portableId] = record;
  }

  for (const [portableId, record] of mintedRecords) {
    extensions[portableId] = record;
  }

  // §4 steps 3–4: refresh this device's own record and bump the counters.
  // Every other device record passes through unchanged.
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION_V2,
    revision: nextRevision(remote.revision),
    updatedAt: timestamp,
    devices: {
      ...remote.devices,
      [deviceId]: {
        label: local.device.label,
        browserFamily,
        lastSeenAt: timestamp,
      },
    },
    extensions,
  };
}
