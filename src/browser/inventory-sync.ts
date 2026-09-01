// Backend-agnostic v2 sync orchestration: fetch → merge → conditional write,
// with a bounded conflict retry, plus the explicit one-way v1→v2 upgrade.
// Implements step 5 of "Producing a local update" and §5 "Rollout sequencing"
// of `docs/design/inventory-schema-v2.md`; the merge itself lives in
// `src/core/inventory-merge.ts`.
//
// Deliberately storage-free: version tokens are parameters and return values,
// never extension-storage reads, so this module is a pure function of its
// arguments plus the injected backend and is testable without a browser.
//
// The conflict retry re-fetches and redoes the whole cycle. That is sound
// only because `mergeLocalObservation` writes solely this device's own keys —
// see that module's maintenance notes. Nothing calls this yet; plan 013 wires
// the four backend services to it.
import {
  BackendError,
  type InventoryBackend,
} from '../backends/contract';
import {
  InventoryFormatError,
  parseInventoryJson,
  type InventoryDocument,
} from '../core/inventory';
import { mergeLocalObservation } from '../core/inventory-merge';
import { liftV1ToV2 } from '../core/inventory-migration';
import {
  INVENTORY_SCHEMA_VERSION_V2,
  parseInventoryJsonV2,
  serializeInventoryV2,
  type InventoryDocumentV2,
} from '../core/inventory-v2';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type RemoteDocumentShape =
  | { kind: 'absent' }
  | { kind: 'v1'; document: InventoryDocument; version: string }
  | { kind: 'v2'; document: InventoryDocumentV2; version: string };

export async function readRemoteDocument(
  backend: InventoryBackend,
): Promise<RemoteDocumentShape> {
  const remote = await backend.read();
  if (!remote) return { kind: 'absent' };

  const text = decoder.decode(remote.data);
  try {
    return {
      kind: 'v2',
      document: parseInventoryJsonV2(text),
      version: remote.version,
    };
  } catch (v2Error) {
    // Only a schema-version mismatch means "maybe v1". Invalid JSON or a
    // malformed v2 body is not a v1 document and propagates as-is.
    if (
      !(v2Error instanceof InventoryFormatError) ||
      v2Error.code !== 'unsupported_schema'
    ) {
      throw v2Error;
    }
    try {
      return {
        kind: 'v1',
        document: parseInventoryJson(text),
        version: remote.version,
      };
    } catch {
      // Neither shape parses; v2 is what this code path expects, so its
      // error is the one worth surfacing.
      throw v2Error;
    }
  }
}

export interface SyncV2Input {
  backend: InventoryBackend;
  /** This device's fresh capture, from `captureInventory`. */
  local: InventoryDocument;
  /** Bounded retries on `BackendError('conflict')`. Default 3. */
  maxAttempts?: number;
  now?: () => Date;
  newExtensionId?: () => string;
}

export interface SyncV2Result {
  document: InventoryDocumentV2;
  version: string;
  attempts: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export async function syncV2(input: SyncV2Input): Promise<SyncV2Result> {
  const { backend, local, now, newExtensionId } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  for (let attempts = 1; ; attempts += 1) {
    const shape = await readRemoteDocument(backend);

    // Rollout rule (§5): an ordinary sync never converts a v1 remote.
    // Upgrading is `upgradeRemoteToV2`, invoked explicitly by the user.
    if (shape.kind === 'v1') {
      throw new BackendError(
        'conflict',
        'This remote still uses the single-device format. Run "Upgrade to multi-device inventory" before syncing.',
      );
    }

    // Creating a brand-new remote is not a migration, so an absent remote
    // starts from an empty v2 document with a create-only write
    // (`expectedVersion: null`).
    const remote: InventoryDocumentV2 =
      shape.kind === 'v2'
        ? shape.document
        : {
            schemaVersion: INVENTORY_SCHEMA_VERSION_V2,
            revision: '0',
            updatedAt: (now ?? (() => new Date()))().toISOString(),
            devices: {},
            extensions: {},
          };
    const expectedVersion = shape.kind === 'v2' ? shape.version : null;

    const merged = mergeLocalObservation({
      remote,
      local,
      ...(now !== undefined ? { now } : {}),
      ...(newExtensionId !== undefined ? { newExtensionId } : {}),
    });

    try {
      const result = await backend.write({
        data: encoder.encode(serializeInventoryV2(merged)),
        expectedVersion,
      });
      return { document: merged, version: result.version, attempts };
    } catch (error) {
      // A conflict means a peer wrote since our read. Redo the whole cycle
      // against a fresh fetch — never the stale document, never the previous
      // merged result. Sound because the merge writes only this device's own
      // keys. Anything else propagates immediately.
      if (
        error instanceof BackendError &&
        error.code === 'conflict' &&
        attempts < maxAttempts
      ) {
        continue;
      }
      throw error;
    }
  }
}

export interface UpgradeResult {
  document: InventoryDocumentV2;
  version: string;
  /** false when the remote was already v2 and nothing was written. */
  upgraded: boolean;
}

export async function upgradeRemoteToV2(
  backend: InventoryBackend,
  options?: { newExtensionId?: () => string },
): Promise<UpgradeResult> {
  const shape = await readRemoteDocument(backend);

  if (shape.kind === 'absent') {
    throw new BackendError(
      'not_found',
      'There is no inventory at this location to upgrade.',
    );
  }

  // Idempotent by design: the options-page action is clickable more than
  // once, so an already-upgraded remote is a no-op with no write.
  if (shape.kind === 'v2') {
    return { document: shape.document, version: shape.version, upgraded: false };
  }

  const lifted = liftV1ToV2(shape.document, options);
  // The upgrade write gets the same optimistic-concurrency protection as
  // every other write (§5). A conflict here is deliberately NOT retried —
  // a racing write during a migration deserves the user's attention.
  const result = await backend.write({
    data: encoder.encode(serializeInventoryV2(lifted)),
    expectedVersion: shape.version,
  });
  return { document: lifted, version: result.version, upgraded: true };
}
