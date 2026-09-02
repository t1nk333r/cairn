# Plan 010: Project a v2 multi-device document down to one device's view so the existing diff keeps working

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Base check (run FIRST, before anything else)**:
> `test -f src/core/inventory-v2.ts && grep -n "InventoryDocumentV2" src/core/inventory-v2.ts`
> If that file does not exist, **STOP immediately and report**. This plan builds
> on plan 008 and must be branched from `advisor/008-inventory-v2-types`, not
> from `main`.
>
> **Drift check**: `git diff --stat b11f485..HEAD -- src/core/diff.ts src/core/inventory.ts`
> → expected empty. On any change, compare the "Current state" excerpts against
> the live code before proceeding.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive — one new module, one new test file)
- **Depends on**: `plans/008-inventory-v2-types.md` (hard dependency). Independent
  of plan 009 — the two can run in parallel from the same base.
- **Category**: migration
- **Planned at**: commit `b11f485`, 2026-09-01

## Why this matters

`diffInventories` (`src/core/diff.ts:27`) compares two flat, single-device v1
documents. A v2 document is neither flat nor single-device: it is a union of
every device's observations, keyed by portable extension id. So the moment
anything in the app reads v2, Compare stops working.

The cheap and correct answer is a **projection**: materialize "what one device
currently sees" out of the union, in exactly the v1 shape the existing diff
already understands. That leaves `src/core/diff.ts` untouched and fully tested,
and it gives the eventual UI work a single well-defined function to call instead
of teaching every consumer about `stateByDevice`.

It also makes tombstones actually mean something. A v2 record can say "device A
had this extension and removed it" (`installed: false` with `deletedAt`), which
must project to *absent* rather than to a disabled extension.

## Current state

### The diff you must keep working, unmodified (`src/core/diff.ts:1-35`)

```ts
import type { ExtensionInventoryItem, InventoryDocument } from './inventory';

export interface InventoryDiff {
  onlyLocal: ExtensionInventoryItem[];
  onlyRemote: ExtensionInventoryItem[];
  versionChanges: VersionChange[];
  stateChanges: StateChange[];
}

const keyOf = (item: ExtensionInventoryItem) =>
  `${item.browserFamily}:${item.id}`;

export function diffInventories(
  local: InventoryDocument,
  remote: InventoryDocument,
): InventoryDiff {
  const localByKey = new Map(local.extensions.map((item) => [keyOf(item), item]));
  const remoteByKey = new Map(remote.extensions.map((item) => [keyOf(item), item]));
  …
}
```

**Do not change `keyOf`.** Making the diff alias-aware across browser families
is real work with real ambiguity (see `docs/design/inventory-schema-v2.md` §3,
the four-step identity ladder) and belongs in its own plan. This plan's job is
narrower: produce well-formed v1-shaped documents that the existing diff can
already handle.

### The v1 shape your projection must produce (`src/core/inventory.ts:5-31`)

```ts
export interface DeviceObservation {
  id: string;
  label: string;
  browserFamily: BrowserFamily;
  browserName: string;
}

export interface ExtensionInventoryItem {
  id: string;
  browserFamily: BrowserFamily;
  name: string;
  version: string;
  enabled: boolean;
  type: string;
  installType?: string;
  homepageUrl?: string;
  updateUrl?: string;
  sourceUrl?: string;
  observedAt: string;
}

export interface InventoryDocument {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
  generatedAt: string;
  device: DeviceObservation;
  extensions: ExtensionInventoryItem[];
}
```

### The sort order every v1 document uses (`src/core/inventory.ts:120-122`)

```ts
.sort((left, right) =>
  left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
)
```

Your projected `extensions` array must use this exact comparator, so a projection
is directly comparable with a freshly captured local inventory.

### The v2 shape you are reading from

Defined by plan 008 in `src/core/inventory-v2.ts`: `InventoryDocumentV2`,
`DeviceRecord`, `ExtensionRecord`, `DeviceExtensionState`. Read that file before
writing code. A worked JSON example is in
`docs/design/inventory-schema-v2.md` §2.

### Two fields v2 does not carry, and what to put there instead

- **`browserName`**: v2's `DeviceRecord` has `label` but no `browserName`
  (matching `PLAN.md:72-78`). Project `browserName` from the device record's
  `label`. That is faithful in practice: `src/browser/device.ts:24-27` defaults
  `label` to `detectBrowserName(navigator.userAgent)` when the user has not set
  one.
- **`type`**: v2's `ExtensionRecord` has no `type` field, because v1 capture only
  ever records extensions — `src/core/inventory.ts:118` filters
  `item.type === 'extension'` before anything is stored. Project the literal
  `'extension'`.

`installType` and `updateUrl` are not carried by v2 either; simply omit those
optional keys from projected items.

### TypeScript strictness — read before writing code

`tsconfig.json:5-6` sets `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. Both bite in this plan:

- `document.devices[deviceId]` is typed `DeviceRecord | undefined`. You must
  narrow it explicitly — that narrowing is also where the unknown-device error in
  step 1 comes from.
- `record.stateByDevice[deviceId]` is likewise possibly `undefined`, which is
  exactly the "this device never saw this extension" case.
- You may not assign `undefined` to `sourceUrl?: string` /
  `homepageUrl?: string`. Use conditional spread:
  `...(value !== undefined ? { sourceUrl: value } : {})`.

No `as any`, and `tsconfig.json` is out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install`) |
| Typecheck | `npm run typecheck` | exit 0, no output |
| All tests | `npm test` | exit 0 |
| One test file | `npm test -- tests/inventory-projection.test.ts` | exit 0 |
| Build | `npm run build` | exit 0 |

## Scope

**In scope** (the only files you may create or modify):

- `src/core/inventory-projection.ts` (create)
- `tests/inventory-projection.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope** — do NOT touch:

- `src/core/diff.ts` — the entire point of this plan is that it does not need to
  change. If you find yourself editing it, stop.
- `src/core/inventory.ts` — v1 stays byte-identical.
- `src/core/inventory-v2.ts` — plan 008 owns it.
- `src/core/inventory-migration.ts` — plan 009 owns it, and may or may not exist
  in your checkout. Do not import from it.
- Anything under `src/browser/` or `entrypoints/` — wiring the projection into
  the options page is a later plan.
- **Cross-family alias-aware diffing.** Tempting and out of scope; see the note
  on `keyOf` above.

## Git workflow

- Branch: `advisor/010-inventory-v2-device-projection`, created **from
  `advisor/008-inventory-v2-types`** — not from `main`.
- Conventional commits, e.g. `feat: project v2 inventories to a per-device view`.
- Do NOT push or open a PR.

## Steps

### Step 1: Create `src/core/inventory-projection.ts`

Exported signature:

```ts
export function projectDeviceInventory(
  document: InventoryDocumentV2,
  deviceId: string,
): InventoryDocument
```

Behavior, precisely:

1. Look up `document.devices[deviceId]`. If it is `undefined`, throw
   `new InventoryFormatError('invalid_inventory', \`Unknown device ${deviceId}.\`)`
   — importing `InventoryFormatError` from `./inventory`. Do not return `null`
   and do not silently produce an empty document; a caller asking about a device
   that isn't in the document has a bug, and it should be loud.
2. Build the `device` field: `id` = `deviceId`, `label` and `browserFamily` from
   the device record, `browserName` = the device record's `label`.
3. For each entry of `document.extensions` (iterate with `Object.entries`), read
   `record.stateByDevice[deviceId]`. **Skip the record entirely** when:
   - there is no state entry for this device (this device has never seen it), or
   - `state.installed === false` (it is absent here), or
   - `state.deletedAt !== undefined` (tombstone).

   The `installed === false` and `deletedAt` checks overlap by design — the
   design doc says `deletedAt` is present only alongside `installed: false`
   (`docs/design/inventory-schema-v2.md` §2) — but check both, so a
   partially-written document still projects safely.
4. Resolve the browser-native id: take `record.aliases[deviceRecord.browserFamily]`
   and use its **first** element. If that array is missing or empty, **skip the
   record** — a record with no id for this device's family cannot be represented
   as a v1 item, and skipping is the safe projection. Do not throw here: this is
   the ordinary cross-family case (an extension known only on Firefox, projected
   for a Chromium device), not corruption.
5. Emit an `ExtensionInventoryItem` with:
   - `id` = the resolved alias, `browserFamily` = the device's family,
   - `name` = `record.name`, `version`/`enabled`/`observedAt` = from `state`,
   - `type` = `'extension'`,
   - `sourceUrl` = `record.sources?.[browserFamily]` when defined, else omit,
   - `homepageUrl` = `record.homepageUrl` when defined, else omit,
   - `installType` and `updateUrl` omitted always.
6. Sort the emitted array with the comparator quoted in "Current state"
   (`name` then `id`).
7. Return `{ schemaVersion: 1, generatedAt: document.updatedAt, device, extensions }`,
   using `INVENTORY_SCHEMA_VERSION` imported from `./inventory` rather than a
   literal.

Add a file-header comment (3–5 lines) explaining that this materializes one
device's view from the v2 union so `diffInventories` can be reused unchanged,
and pointing at `docs/design/inventory-schema-v2.md` §5 "Files that change".

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Write `tests/inventory-projection.test.ts`

See "Test plan" below.

**Verify**: `npm test -- tests/inventory-projection.test.ts` → exit 0.

### Step 3: Prove the projection composes with the untouched diff

The load-bearing claim of this plan is that `diffInventories` needs no changes.
Test it directly: build one v2 document with two devices whose views genuinely
differ, project both, pass the two projections to `diffInventories`, and assert
the diff reports the differences you constructed. This is case 10 below.

**Verify**: `npm test -- tests/inventory-projection.test.ts` → exit 0.

### Step 4: Full verification

**Verify**:
- `npm test` → exit 0, all pre-existing tests still pass (including
  `tests/diff.test.ts` and `tests/inventory-characterization.test.ts`).
- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `git diff -- src/core/diff.ts src/core/inventory.ts` → empty output.

## Test plan

Create `tests/inventory-projection.test.ts`. Model its structure on
`tests/diff.test.ts` (read it first) — `import { describe, expect, it } from 'vitest';`,
module-scope factory helpers, no mocks.

Build a v2 fixture with **two devices** (one `chromium`, one `firefox`) and at
least four extension records:

- **A** — installed and enabled on both devices, aliased in both families.
- **B** — installed on the Chromium device only.
- **C** — tombstoned on the Chromium device (`installed: false`, `deletedAt`
  set), installed on the Firefox device.
- **D** — a Firefox-only record (no `chromium` key in `aliases`) installed on the
  Firefox device.

Required cases:

1. Projecting the Chromium device yields exactly A and B, sorted by name.
2. Projecting the Firefox device yields exactly A, C, and D.
3. Every projection satisfies `isInventoryDocument` (imported from
   `../src/core/inventory`) — the projection must be indistinguishable from a
   real v1 document.
4. The projected `device` carries the right `id`, `label`, and `browserFamily`,
   and its `browserName` equals the v2 `label`.
5. Projected `generatedAt` equals the v2 document's `updatedAt`.
6. **Tombstone exclusion**: C does not appear in the Chromium projection, and
   asserting on its absence specifically (not just on array length).
7. **Alias resolution**: A's projected `id` is the Chromium alias when projecting
   the Chromium device and the Firefox alias when projecting the Firefox device.
8. **Missing-alias skip**: D is absent from the Chromium projection and no error
   is thrown.
9. **Unknown device**: `projectDeviceInventory(fixture, 'nope')` throws
   `InventoryFormatError` with `code === 'invalid_inventory'`.
10. **Composes with the real diff**: `diffInventories(projectChromium, projectFirefox)`
    (importing `diffInventories` from `../src/core/diff`, unmodified) reports B
    under `onlyLocal` and C/D under `onlyRemote`. Note that A appears in neither
    list only if both devices' aliases happen to match on the same family — with
    genuinely different per-family ids the existing `keyOf` will treat them as
    different extensions. **Assert the actual current behavior**, and add a
    one-line comment in the test saying that cross-family matching is deliberately
    not implemented yet and is tracked in
    `docs/design/inventory-schema-v2.md` §3. Do not "fix" the diff to make a
    nicer assertion possible.
11. **Version and state fidelity**: an extension whose `stateByDevice` entries
    carry different `version` values per device projects each device's own
    version, and `enabled: false` on one device projects as disabled there and
    enabled on the other.
12. **Empty device**: a device with no matching extension records projects to
    `extensions: []` and still passes `isInventoryDocument`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, with every pre-existing test still passing
- [ ] `npm test -- tests/inventory-projection.test.ts` exits 0 covering all 12 cases
- [ ] `npm run build` exits 0
- [ ] `git diff -- src/core/diff.ts src/core/inventory.ts src/core/inventory-v2.ts` produces empty output
- [ ] `git status --short` lists exactly `src/core/inventory-projection.ts` and `tests/inventory-projection.test.ts` as new, plus the `plans/README.md` edit
- [ ] `grep -c "as any" src/core/inventory-projection.ts` returns 0
- [ ] `plans/README.md` status row for 010 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/core/inventory-v2.ts` does not exist or does not export
  `InventoryDocumentV2`. Your worktree was branched from the wrong base.
- The `src/core/diff.ts` excerpt above no longer matches the live file.
- You conclude the projection cannot be made to satisfy `isInventoryDocument`
  without changing either `src/core/inventory.ts` or `src/core/inventory-v2.ts`.
  That is a genuine design disagreement between plans and needs a human.
- You are tempted to make `keyOf` in `src/core/diff.ts` alias-aware to get a
  cleaner result in case 10. Report the observation instead; it is the correct
  input to the identity-resolution plan, not something to fix here.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

For whoever owns this next:

- **Nothing calls `projectDeviceInventory` when this lands.** Its intended
  consumers are the options page's Compare view and the five
  `src/browser/*-service.ts` pull paths, once those speak v2.
- The projection is deliberately **lossy and one-way**. It answers "what does
  device X see?" and cannot be inverted — do not let a later plan try to write a
  projection back to a remote, which would recreate exactly the overwrite bug
  that v2 exists to fix. Writes must go through the merge algorithm
  (`docs/design/inventory-schema-v2.md` §4), which is not yet written.
- The known gap this plan leaves open, on purpose: cross-family comparison still
  does not work, because `keyOf` includes `browserFamily`. Projection is a
  prerequisite for fixing that, not the fix. The four-step identity ladder in
  §3 of the design doc is the specification when someone takes it on.
- A reviewer should scrutinize the skip conditions in step 1.3–1.4: the
  difference between "skip quietly" (no alias for this family — normal) and
  "throw" (unknown device — caller bug) is the subtlest judgment in this plan.
