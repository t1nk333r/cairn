<title>Inventory schema v2: multi-device design</title>

# Inventory schema v2: multi-device inventory

Status: **design spike, not approved for implementation.** This document
specifies what schema v2 should look like and how to get there. It does not
change any code. A human must approve this design before the migration it
describes is implemented (see `plans/005-multi-device-schema-spike.md`).

Companion characterization tests that pin the v1 behavior referenced
throughout this document live in
`tests/inventory-characterization.test.ts`.

## 1. Problem

Cairn's stated purpose is comparing and restoring browser extensions across
multiple devices. The shipped v1 document cannot represent more than one
device at a time:

```ts
// src/core/inventory.ts:26-31
export interface InventoryDocument {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
  generatedAt: string;
  device: DeviceObservation;       // <- exactly one device
  extensions: ExtensionInventoryItem[]; // <- that device's extensions only
}
```

Every backend's upload path serializes *the local device's whole document*
as the entire remote file, and every pull path stores what it read as a
local comparison baseline — it never folds remote content into anything.
This holds identically across all five backends:

| Backend | Pull (reads remote, never merges) | Upload (overwrites remote wholesale) |
|---|---|---|
| WebDAV | `src/browser/webdav-service.ts:33-45` | `src/browser/webdav-service.ts:47-68` |
| S3 | `src/browser/s3-service.ts:33-45` | `src/browser/s3-service.ts:47-67` |
| Gitea | `src/browser/gitea-service.ts:33-45` | `src/browser/gitea-service.ts:47-67` |
| GitHub (contents API) | `src/browser/github-service.ts:29-36` | `src/browser/github-service.ts:38-55` |
| Native Git companion | `src/browser/native-service.ts:100-117` | `src/browser/native-service.ts:119-142` |

Every pull path calls `parseInventoryJson` on the remote bytes and then
`saveComparisonBaseline(inventory)` (e.g. `src/browser/webdav-service.ts:39-43`,
which persists under a `comparisonBaseline` key —
`src/browser/inventory-store.ts:17-21`). It never touches the local device's
own captured document, which lives under a *different* storage key,
`latestInventory` (`src/browser/inventory-store.ts:7-9`, written by
`saveInventory` and read back by `loadInventory`).

Every upload path calls `loadInventory()` — the local device's own captured
document — and writes it, and only it, to the backend
(e.g. `src/browser/webdav-service.ts:49,62-65`). The comparison baseline
pulled a moment earlier is used only to gate a conflict warning
(`if (baseline && !knownVersion) throw …`, `src/browser/webdav-service.ts:56-61`)
and is never merged into the bytes that get written.

### The exact data-loss interleaving

1. Device A captures its own extensions via `captureInventory`
   (`src/core/inventory.ts:107-130`) and stores them locally under
   `latestInventory` (`inventory-store.ts:7-9`).
2. Device A uploads. `uploadWebDavInventory` reads A's local document
   (`webdav-service.ts:49`) and writes it as the entire remote file with
   `expectedVersion: null` on the first write (`webdav-service.ts:62-65`).
   The remote is now exactly A's document.
3. Device B pulls. `pullWebDavInventory` reads the remote (A's document),
   parses it, and stores it as B's *comparison baseline*
   (`webdav-service.ts:39-43` → `inventory-store.ts:17-21`). B's own local
   `latestInventory` is untouched — it still holds only B's own captured
   extensions, which is a completely separate value from what was just
   pulled.
4. Device B uploads. `uploadWebDavInventory` reads B's own local document
   (`webdav-service.ts:49`, B's own extensions — not the baseline pulled in
   step 3) and writes it as the entire remote file
   (`webdav-service.ts:62-65`), using the version token obtained in step 3 as
   `expectedVersion`. The optimistic-concurrency check passes (B did pull
   first), so the write succeeds.
5. The remote is now exactly B's document. **A's extensions, which existed
   only in the remote and never in B's local storage, are gone.** No error
   was raised anywhere in this sequence.

Optimistic concurrency (the `expectedVersion` / backend `version` token,
`src/backends/contract.ts:1-13`) only prevents B from overwriting a version
of the remote it hasn't seen. It does not, and structurally cannot, prevent
B from overwriting the *content* of a version it has seen with unrelated
content, because nothing in the write path is a function of what was read.
**Today's remote file is whichever device wrote last** — precisely the
last-write-wins behavior `PLAN.md`'s "Sync and merge behavior" section
(`PLAN.md:179-189`) says the project avoids, but the code does not yet
implement that avoidance.

All five services follow the identical read-then-overwrite shape; none of
them merges. This confirms the plan's premise — the STOP condition for "any
service merges instead of overwriting" does not apply.

## 2. Proposed v2 document

This follows `PLAN.md`'s "Inventory schema" section (`PLAN.md:64-116`)
closely, with the deviations noted below.

### JSON example

```json
{
  "schemaVersion": 2,
  "revision": "42",
  "updatedAt": "2026-08-31T09:00:00.000Z",
  "devices": {
    "01J8Z1QK3G000000000000LAPTOP": {
      "label": "Laptop",
      "browserFamily": "chromium",
      "lastSeenAt": "2026-08-31T09:00:00.000Z"
    },
    "01J8Z1QK3G000000000000PHONE": {
      "label": "Phone (Firefox)",
      "browserFamily": "firefox",
      "lastSeenAt": "2026-08-30T21:00:00.000Z"
    }
  },
  "extensions": {
    "01J8Z1QK4X000000000EXAMPLE": {
      "name": "Example",
      "aliases": {
        "chromium": ["abcdefghijklmnopabcdefghijklmnop"],
        "firefox": ["example@example.org"]
      },
      "sources": {
        "chromium": "https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop",
        "firefox": "https://addons.mozilla.org/firefox/addon/example/"
      },
      "homepageUrl": "https://example.org",
      "stateByDevice": {
        "01J8Z1QK3G000000000000LAPTOP": {
          "installed": true,
          "enabled": true,
          "version": "1.2.3",
          "observedAt": "2026-08-31T09:00:00.000Z"
        },
        "01J8Z1QK3G000000000000PHONE": {
          "installed": false,
          "enabled": false,
          "version": "1.1.0",
          "observedAt": "2026-08-29T12:00:00.000Z",
          "deletedAt": "2026-08-30T21:00:00.000Z"
        }
      }
    },
    "01J8Z1QK50000000000ORPHAN": {
      "name": "Only-on-phone Extension",
      "aliases": { "firefox": ["orphan@example.org"] },
      "sources": {},
      "stateByDevice": {
        "01J8Z1QK3G000000000000PHONE": {
          "installed": true,
          "enabled": true,
          "version": "0.9.0",
          "observedAt": "2026-08-30T21:00:00.000Z"
        }
      }
    }
  }
}
```

This example shows: two devices; one extension present on both (aliased
across families, currently installed on the laptop, **tombstoned** on the
phone — the phone user removed it); one extension known only from the phone.
Note that the tombstoned entry is not deleted from `stateByDevice` — it is
retained with `installed: false` and `deletedAt` set, per
`PLAN.md:182-184`.

### TypeScript interfaces

```ts
export const INVENTORY_SCHEMA_VERSION = 2 as const;

export type BrowserFamily = 'chromium' | 'firefox';

export interface DeviceRecord {
  label: string;
  browserFamily: BrowserFamily;
  lastSeenAt: string; // ISO 8601
}

export interface DeviceExtensionState {
  installed: boolean;
  enabled: boolean;
  version: string;
  observedAt: string;   // ISO 8601, when this state was last captured
  deletedAt?: string;    // ISO 8601 tombstone timestamp; present iff installed === false
                          // and this device previously reported installed === true
}

export interface ExtensionRecord {
  name: string;
  // At least one browserFamily key must be present. An id may appear at
  // most once across all extension records' aliases (invariant enforced by
  // the merge algorithm, section 4).
  aliases: Partial<Record<BrowserFamily, string[]>>;
  sources?: Partial<Record<BrowserFamily, string>>;
  homepageUrl?: string;
  // Keyed by device id (same ids as `devices`). An entry exists for every
  // device that has ever observed this extension, whether or not it is
  // currently installed there.
  stateByDevice: Record<string, DeviceExtensionState>;
}

export interface InventoryDocumentV2 {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
  // Monotonically increasing logical clock, incremented on every merge that
  // is actually written. See "Open questions" (§7.2) for why this exists
  // alongside the backend's own opaque version/ETag token.
  revision: string;
  updatedAt: string; // ISO 8601, wall-clock time of the write that produced this revision
  devices: Record<string, DeviceRecord>;         // keyed by device id
  extensions: Record<string, ExtensionRecord>;   // keyed by portable extension id
}
```

### Deviations from `PLAN.md`

- `PLAN.md`'s example shows `"revision": "018f..."` without specifying its
  shape. This document proposes a plain incrementing decimal string (`"42"`)
  rather than a hash or ULID, specifically so that Git diffs of the JSON
  file show a small, human-legible counter change on every commit — the
  same "useful Git diffs" goal `PLAN.md:66-67` states for the document as a
  whole. A content hash would change unpredictably and add no readable
  information over the backend's own version token.
- `PLAN.md`'s per-device entry doesn't list an id field because the id is
  the map key; this document keeps that convention and does the same for
  `extensions`, using portable extension ids as keys rather than as fields
  inside the record (marginally more compact, and matches how `devices` is
  already shown in `PLAN.md`).
- Everything else (the `devices` map shape, `aliases`, `sources`,
  `stateByDevice`, tombstone-by-timestamp) follows `PLAN.md` as specified;
  no other deviation is proposed.

## 3. Identity resolution

Goal: decide when a Chromium extension id and a Firefox extension id refer
to "the same" logical extension, so they share one `ExtensionRecord` and one
`stateByDevice` view, without ever silently merging two unrelated
extensions. Follows `PLAN.md:106-111`'s four-step ladder exactly:

1. **Exact browser-family id match wins.** If a newly observed id already
   appears in some extension record's `aliases[browserFamily]` array, that
   observation updates that record's `stateByDevice` entry for the
   reporting device. No user interaction.
2. **User-confirmed alias links Firefox and Chromium records.** See below —
   this is the only way two *different* ids, one per family, become linked
   for the first time.
3. **A unique canonical project/store URL may be proposed as a match.** If
   a newly observed extension's inferred `sourceUrl` (via
   `inferSourceUrl`, `src/core/inventory.ts:76-85`) matches exactly one
   existing extension record's `sources[otherFamily]` value, and only one,
   present it to the user as a proposed link (does not auto-link — "may be
   proposed" in `PLAN.md:110` is deliberately weaker than step 1's "wins").
   If it matches zero or more than one existing record, no proposal is
   made and the observation becomes its own new extension record.
4. **Name-only matches are suggestions and are never merged
   automatically** (`PLAN.md:111`). A same-name, different-family,
   no-shared-URL pair is surfaced in the UI as "possibly the same
   extension?" with a manual "Link" action, and otherwise remains two
   separate extension records forever.

### What "user-confirmed alias" means concretely

- **In storage:** confirming a link between an existing Chromium-only
  extension record and an existing Firefox-only extension record merges the
  two `ExtensionRecord` values into one: the surviving record's `aliases`
  gains the other family's id array, `sources` gains the other family's
  entry (if present), and `stateByDevice` is the union of both records'
  device-state maps (their key sets cannot collide, since a device can only
  have reported into one of the two pre-merge records). The other portable
  extension id is deleted from the `extensions` map — there is no
  "confirmed" boolean field anywhere; presence of both families' ids inside
  one record's `aliases` **is** the confirmation. A rejected or
  not-yet-confirmed proposal is never written to the document at all; it
  exists only as transient UI state (a proposed-pairs list computed
  client-side from step 3/4 above, recomputed on every load).
- **In the UI:** the options page (`entrypoints/options/main.tsx`) shows a
  "Possible matches" panel below the existing diff view (the diff view
  already imports `diffInventories`, `entrypoints/options/main.tsx:4`;
  this is new UI, not a rework of it) listing each proposed pair with both
  names, ids, and (if available) source URLs, and two buttons: "Link" (does
  the merge above) and "Not the same" (dismisses the suggestion for that
  pair; dismissal state can be kept client-side only — it is cheap to
  re-derive and re-dismiss, and does not need to round-trip through the
  synced document).
- Two extension records may never be merged as a side effect of a device
  sync; merging only happens through this explicit user action or through
  the automatic step-1 exact-id match. This is what "never merged
  automatically" means operationally.

## 4. Merge algorithm

**Each device updates only its own `stateByDevice` entries** (and,
incidentally, may add new `ExtensionRecord`s for extensions no other device
has ever reported, and may extend `aliases`/`sources` for records it
resolves against per §3). It never rewrites another device's
`stateByDevice` entry and never removes another device's `DeviceRecord`.

### Producing a local update

On every capture/sync cycle, a device D with fresh local observations
`localExtensions` (the output of today's `captureInventory`,
`src/core/inventory.ts:107-130`) does, against the latest fetched remote
union document `remote`:

1. For each item in `localExtensions`, resolve it to a portable extension
   id via §3 (exact alias match, or create a new `ExtensionRecord` if
   nothing matches and no proposal is pending). Write/overwrite
   `remote.extensions[portableId].stateByDevice[D]` with
   `{ installed: true, enabled, version, observedAt: now }` (no
   `deletedAt`).
2. For each portable extension id where `remote.extensions[id].stateByDevice[D]`
   currently exists with `installed: true` but the id was **not** produced
   in step 1 (D no longer reports that extension as installed), write a
   tombstone: `{ installed: false, enabled: false, version: <last known>,
   observedAt: now, deletedAt: now }`. This is the only way a
   `deletedAt` is ever set, and it is always set by the same device whose
   `stateByDevice` entry it belongs to — device D can tombstone only its
   own prior observation, never another device's.
3. Update `remote.devices[D] = { label, browserFamily, lastSeenAt: now }`.
4. Bump `remote.revision` (increment) and `remote.updatedAt = now`.
5. Write the result with `expectedVersion` set to the backend version the
   `remote` was fetched at (unchanged mechanism from
   `src/backends/contract.ts:1-13`).

An **offline device cannot resurrect a removed record** because step 2 only
ever tombstones D's *own* entries; a device that has been offline and never
saw a peer's deletion simply has no way to touch that peer's
`stateByDevice[peer]` entry at all — the write in step 1/2 is scoped to `D`'s
own key by construction, so there is no code path by which an offline
device's stale local state could overwrite another device's
already-recorded tombstone. This directly satisfies `PLAN.md:182-184`.

### Two devices delete the same extension

No conflict, by construction: device A's sync writes a tombstone into
`stateByDevice[A]`; device B's sync (independently, before or after A's) writes a
tombstone into `stateByDevice[B]`. These are different keys in the same map.
Whichever sync runs second simply adds its own tombstone entry to a document
that already contains the other device's tombstone (fetched fresh per the
optimistic-concurrency retry below) — both tombstones coexist. There is
nothing to reconcile because per-device state is a union of independent
values, not a single field being contended over.

### Pruning

Never automatic. A separate, explicit maintenance action (a settings-page
button, e.g. "Clean up removed devices and extensions") lists devices whose
`lastSeenAt` is older than a user-chosen threshold and extension records
where every `stateByDevice` entry has `installed: false`, and only on
explicit confirmation deletes those `devices`/`extensions` entries in one
write. This matches `PLAN.md:184`'s "pruned only through an explicit
maintenance action" and is a distinct code path from the per-sync merge
above — the per-sync merge must never delete a map entry, only add or
tombstone one.

### Conflict when the optimistic-concurrency check fails mid-merge

Because the write in step 5 above is rejected by the backend when
`expectedVersion` no longer matches (`src/backends/contract.ts` `write`
contract, surfaced as `BackendError('conflict', …)` in current code, e.g.
`webdav-service.ts:56-61` for the pre-pull case), the retry is: **re-fetch
the remote, and redo steps 1–5 against the freshly fetched document** —
never retry against the stale pre-conflict document. Because steps 1–3 only
ever add or overwrite this device's own map entries (never read-modify-write
another device's entry, and never depend on the prior value of `revision`
beyond needing *some* baseline to increment), redoing the whole local-update
computation against a newer `remote` is safe and produces the same
semantic result regardless of how many times another device's concurrent
write raced ahead of it. This is a meaningfully stronger guarantee than v1's
conflict handling, where a retry after `BackendError('conflict', …)` still
just re-overwrites wholesale (see §1) — v2's retry is safe specifically
*because* the merge is scoped per-device-key, whereas v1's "retry" is
actually just "try clobbering again."

The one case that is not automatically conflict-free is a race in identity
resolution itself: if two devices simultaneously confirm *different* aliases
for the same ambiguous pair (rare, since it requires two users acting within
the same short window on the options-page UI in §3), the merge above applies
whichever alias-confirmation write lands second, and the recommendation is
to surface this as a visible warning ("this extension's cross-browser link
changed since you last viewed it") rather than attempt automatic
reconciliation — this is a low-frequency, user-driven event, not a routine
sync collision, and the safe/simple answer (last-confirmed-wins with a
visible notice) is acceptable specifically because it cannot lose install
state (only an alias grouping), unlike v1's whole-document overwrite.

## 5. Migration path

**Constraint, pinned by
`tests/inventory-characterization.test.ts` ("3. rejects schemaVersion 2…")**:
`parseInventoryJson` today throws `InventoryFormatError('unsupported_schema', …)`
for any `schemaVersion !== 1`
(`src/core/inventory.ts:170-181`), unconditionally. Every currently
installed v1 client that pulls a v2 remote gets a hard, loud error — it does
not silently misread the new shape. This is a safety property to preserve,
not a defect to route around: a v1 client that *tolerated* an unrecognized
v2 document by ignoring the fields it doesn't understand would, on its next
upload, write back a flattened single-device view — reintroducing exactly
the bug this document exists to fix. **Recommendation: keep the hard
reject.** Do not attempt to make v1 clients forward-compatible with v2
documents.

### Lifting a v1 remote to v2

Given a v1 `InventoryDocument` (`src/core/inventory.ts:26-31`), produce
exactly one `devices` entry and exactly one `stateByDevice` entry per
extension, as follows:

```ts
function liftV1ToV2(v1: InventoryDocumentV1): InventoryDocumentV2 {
  const deviceId = v1.device.id;
  return {
    schemaVersion: 2,
    revision: '1',
    updatedAt: v1.generatedAt,
    devices: {
      [deviceId]: {
        label: v1.device.label,
        browserFamily: v1.device.browserFamily,
        lastSeenAt: v1.generatedAt,
      },
    },
    extensions: Object.fromEntries(
      v1.extensions.map((item) => [
        newPortableId(), // freshly minted; see §7.1
        {
          name: item.name,
          aliases: { [item.browserFamily]: [item.id] },
          sources: item.sourceUrl ? { [item.browserFamily]: item.sourceUrl } : {},
          homepageUrl: item.homepageUrl,
          stateByDevice: {
            [deviceId]: {
              installed: true,
              enabled: item.enabled,
              version: item.version,
              observedAt: item.observedAt,
            },
          },
        },
      ]),
    ),
  };
}
```

No cross-family aliasing is possible at lift time — a v1 document only ever
holds one browser family's ids, so every lifted extension record starts
with exactly one family populated in `aliases`/`sources`; identity
resolution (§3) only has something to do once a *second* device's v1
document (or a v2-native device) is merged in.

### Rollout sequencing (what the user sees)

1. Ship v2-capable code that still **defaults to writing v1-shaped
   documents** for any backend whose remote is currently v1 or empty. No
   existing single-device user is force-migrated by an extension update
   alone.
2. Add an explicit "Upgrade to multi-device inventory" action (options
   page). On click: pull the current remote, run `liftV1ToV2` if it is
   still v1-shaped, write the v2 document with `expectedVersion` from the
   pull (so the same optimistic-concurrency protection applies to the
   upgrade write itself), and flip this device's local mode to v2.
3. From that point on, this device's pulls/uploads always speak v2 to that
   backend. If a *different*, not-yet-upgraded device pulls this backend's
   remote afterward, `parseInventoryJson` (still v1-only on that device)
   throws `unsupported_schema`, surfaced in the UI as "This inventory was
   upgraded to multi-device format on another device — install the latest
   version of Cairn on this device to continue syncing," not a generic
   parse error. That copy change is new UI string work, not a schema
   change.
4. No downgrade path is provided. Writing v2 content back down to v1 shape
   would need to collapse multiple devices into one and discard tombstone
   history — a lossy, one-way operation in the wrong direction — so once a
   given backend's remote is upgraded, it stays v2. This is a one-way door
   per backend (not per install): a user with multiple sync backends could
   in principle upgrade one and leave another on v1 during a transition
   period, though this document does not recommend encouraging that as a
   normal workflow.

### Files that change

- `src/core/inventory.ts` — new v2 types alongside the retained v1 types
  (needed for `liftV1ToV2`'s input); `INVENTORY_SCHEMA_VERSION` becomes 2;
  new `parseInventoryJsonV2`/`serializeInventoryV2` (names illustrative);
  the v1 parse/serialize functions are retained under different names
  purely to feed the lift function and the characterization tests that
  pin v1 reading.
- A new `src/core/inventory-migration.ts` (or similarly named module) for
  `liftV1ToV2` and the local-update merge algorithm in §4, kept separate
  from `inventory.ts` so the migration logic has its own focused test
  file.
- `src/core/diff.ts` — `diffInventories` currently compares two flat
  `InventoryDocument`s (`src/core/diff.ts:27-30`) by
  `browserFamily:id` (`src/core/diff.ts:24-25`). Against a v2 union
  document, "local vs remote" needs a projection step first (materialize
  "this device's current view" from `stateByDevice[thisDeviceId]` across
  all extension records), then the existing comparison logic can mostly be
  reused against two projections.
- All five `src/browser/*-service.ts` files — pull must fold the fetched
  document into local knowledge of the union (no `saveComparisonBaseline`
  overwrite of unrelated content), and upload must run the §4 local-update
  algorithm against a freshly fetched remote rather than write
  `loadInventory()` wholesale.
- `src/browser/inventory-store.ts` — the `comparisonBaseline` concept
  (`inventory-store.ts:17-27`) is largely superseded by "the union document
  itself is the thing being compared against"; whether it's deleted or
  repurposed as a cache is an implementation decision for that later plan.
- `entrypoints/options/main.tsx` — consumes `InventoryDocument`,
  `parseInventoryJson`, `diffInventories` directly
  (`entrypoints/options/main.tsx:4-8`) and renders device/extension counts
  from the v1 shape (`entrypoints/options/main.tsx:519-521`); needs the new
  alias-confirmation UI from §3 and updated rendering for a per-device
  projection instead of a single flat document.
- Every existing test file that constructs an `InventoryDocument` or calls
  `parseInventoryJson`/`serializeInventory`/`diffInventories`
  (`tests/inventory.test.ts`, `tests/import-export.test.ts`,
  `tests/diff.test.ts`, and the five backend test files
  `tests/webdav.test.ts`, `tests/s3.test.ts`, `tests/gitea.test.ts`,
  `tests/github.test.ts`, `tests/native-protocol.test.ts`) needs new or
  additional coverage for v2 shapes. `tests/inventory-characterization.test.ts`
  itself should require no changes — it exists specifically to keep
  asserting v1 behavior unchanged.

## 6. Encryption sequencing

`PLAN.md`'s "Secrets and encryption" section (`PLAN.md:167-178`) specifies
an optional AES-256-GCM envelope with a random nonce per write, and leaves
"opt-in or default" as an open decision (`PLAN.md:302-303`).

**Recommendation: sequence schema v2 before encryption**, for both reasons
raised in this plan's "Why this matters":

1. **Migration compounding.** If encryption ships first, wrapping today's
   v1 document, then the v2 migration in §5 has to happen *underneath* an
   opaque envelope: decrypt every existing remote, run `liftV1ToV2`,
   re-encrypt, write back — on remotes real users already hold, with the
   passphrase-recovery and key-management concerns of §7 layered directly
   on top of the already-hard schema migration. Sequencing schema first
   means the encryption envelope is designed once, against the final v2
   canonical JSON shape, with no second migration required afterward.
2. **Diff readability vs. ciphertext.** A fresh nonce per write
   (`PLAN.md:174`) is required for AES-GCM's security guarantees, but it
   also means the ciphertext bytes for an unchanged document differ
   completely between two consecutive writes. Every commit to a Git/Gitea
   remote becomes an opaque full-file binary replacement, which destroys
   the "useful Git diffs" property the schema is explicitly designed to
   provide (`PLAN.md:66-67`) and undercuts the auditable-history/rollback
   value claimed for the Git and Gitea backends (`PLAN.md:150`,
   "Each successful write creates a normal commit, providing history and
   rollback"). Rollback still works (you can revert to a prior commit's
   ciphertext), but "read the history" does not.

These two properties are in real tension for any backend that stores the
document in a version-controlled text format: you can have either an
inspectable/diffable history or confidentiality-at-rest for that history,
not both, for as long as encryption uses a per-write random nonce. This
document does not propose resolving that tension (e.g. via a
deterministic/nonce-derived scheme, which would weaken AES-GCM's
guarantees) — it is flagged as an open trade-off in §7.

### Recommendation: opt-in, not default

Reasons, stated honestly alongside the counter-argument:

- Encryption directly trades away the diffable-history benefit above,
  which is a stated differentiator of the Git/Gitea backends
  (`PLAN.md:150`). Defaulting to encrypted would default away that benefit
  for every Git/Gitea user without them choosing to.
- `PLAN.md:175-176` specifies the passphrase is held in memory by default,
  with "remembering it" as an explicit opt-in carrying "a clear warning" —
  i.e. the design already anticipates that losing the passphrase loses
  access. No passphrase-recovery mechanism is described anywhere in
  `PLAN.md`. Defaulting to encrypted-on means every new user is opted into
  an unrecoverable-secret failure mode by default, for a tool whose whole
  point is not losing your extension inventory.
- WebDAV and S3 backends are typically already access-controlled at the
  transport/storage layer (authenticated WebDAV, a private S3 bucket) —
  the specific threat encryption defends against (the storage operator or
  someone with read access to the remote reading extension names/URLs) is
  real but narrower than "everyone using this feature," which is the usual
  bar for defaulting a feature on.
- **Counter-argument, stated fairly:** encrypted-by-default is more
  privacy-protective out of the box and matches "secure by default"
  norms — a user who never discovers the encryption toggle gets no
  protection under an opt-in default, whereas an opt-in-out default still
  protects the security-conscious minority who will find the toggle either
  way. If a future release adds a real passphrase-recovery flow (not
  currently specified), that materially weakens the case for opt-in and
  this recommendation should be revisited.

Given the unresolved recovery story and the explicit Git-diffability goal
already in `PLAN.md`, **opt-in is the recommended default for the
foreseeable v2 work**; defaulting to encrypted-on should wait until a
recovery UX exists.

## 7. Open questions

Each phrased as a decision only the maintainer can make, with a recommended
answer.

1. **Portable extension id generation.** Recommendation: a randomly
   generated id (ULID or UUIDv4) minted once when an `ExtensionRecord` is
   first created, stored as the map key, and never recomputed. A
   deterministic id derived from the first-seen alias would have to change
   if that alias later needs correcting, which breaks anything referencing
   it by id in the meantime.
2. **Is the in-document `revision` field redundant with the backend's own
   `version`/ETag token (`src/backends/contract.ts:1-13`)?** They serve
   different audiences: the backend `version` is an opaque
   optimistic-concurrency token (a Git SHA, an ETag) used purely for the
   compare-and-swap write; `revision` inside the document is proposed as a
   small human-legible counter (§2's deviation note) purely so a `git log
   -p` or diff view shows an incrementing number, not two opaque hashes.
   Recommendation: keep both, they answer different questions.
3. **What exactly counts as a "unique canonical URL" for step 3 of identity
   resolution (§3)?** `inferSourceUrl` (`src/core/inventory.ts:76-85`)
   already normalizes Chromium Web Store ids into a URL; there is no
   equivalent canonicalization for AMO (Firefox) URLs with query strings or
   locale prefixes today. Recommendation: normalize by stripping query
   strings and known locale path segments before comparing, but this needs
   a small survey of real AMO URL variants before it's specified precisely
   enough to implement — out of scope for this spike.
4. **Pruning threshold.** How old must a device's `lastSeenAt` be before it
   is offered for pruning? Recommendation: default to 90 days, user
   adjustable, always requiring explicit confirmation per §4 — never
   time-based automatic deletion.
5. **Device churn (e.g. disposable VMs/containers running a browser)
   accumulating many device entries.** Not addressed by this design.
   Recommendation: treat as a special case of pruning (§4) rather than a
   separate mechanism, and revisit only if it turns out to matter in
   practice — no evidence in this repository that it currently does.
6. **Encryption's diff-opacity vs. confidentiality tension (§6).**
   Recommendation given in §6: accept the tension, ship opt-in, and treat
   any resolution (e.g. per-field encryption, deterministic nonces with a
   documented weaker guarantee) as a separate, later design decision — do
   not block schema v2 on solving it.
7. **License and first additional Git host** (`PLAN.md:299-301`) — outside
   this document's scope entirely; noted only because `PLAN.md` lists them
   under the same "Decisions needed" heading as the encryption
   default question this document does answer.

## 8. Estimated blast radius

Rough sizes, for scoping the follow-up implementation plan (this spike's
Status line already estimates that plan's effort as L):

| File | Nature of change | Rough size |
|---|---|---|
| `src/core/inventory.ts` | Add v2 types, `INVENTORY_SCHEMA_VERSION` → 2, v2 parse/serialize; retain v1 types/functions for the lift path | Large (~150–250 changed/added lines) |
| `src/core/inventory-migration.ts` (new) | `liftV1ToV2`, local-update merge algorithm (§4) | Medium (~100–150 new lines) |
| `src/core/diff.ts` | Add a per-device projection step ahead of the existing comparison | Medium (~60–100 changed lines) |
| `src/browser/webdav-service.ts` | Pull/upload rewritten to merge (§4) instead of overwrite | Medium (~30–50 changed lines) |
| `src/browser/s3-service.ts` | Same shape as webdav-service.ts | Medium (~30–50 changed lines) |
| `src/browser/gitea-service.ts` | Same shape | Medium (~30–50 changed lines) |
| `src/browser/github-service.ts` | Same shape | Medium (~30–50 changed lines) |
| `src/browser/native-service.ts` | Same shape, plus base64 envelope unchanged | Medium (~30–50 changed lines) |
| `src/browser/inventory-store.ts` | Retire or repurpose `comparisonBaseline` | Small (~20 changed lines) |
| `entrypoints/options/main.tsx` | New alias-confirmation UI (§3); rendering updated for per-device projection instead of flat document (currently 1090 lines total, imports `diffInventories`/`parseInventoryJson`/`InventoryDocument` directly at lines 4-8 and renders flat counts at lines 519-521) | Large (~200–400 changed/added lines; not fully surveyed in this spike) |
| `tests/inventory.test.ts`, `tests/import-export.test.ts`, `tests/diff.test.ts` | Add v2 coverage alongside existing v1 coverage | Medium, combined |
| `tests/webdav.test.ts`, `tests/s3.test.ts`, `tests/gitea.test.ts`, `tests/github.test.ts`, `tests/native-protocol.test.ts` | Add merge-path coverage per backend | Medium–Large, combined |
| `tests/inventory-characterization.test.ts` | No change expected — this is the safety net that proves v1 reading still works | None |

No estimate is given for a passphrase-recovery UX or the encryption
envelope itself — both are explicitly out of scope for the plan this
document specifies (§6).
