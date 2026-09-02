# Plan 011: Implement the per-device merge that makes concurrent syncs stop destroying each other's data

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. Do not update `plans/README.md` unless your
> dispatcher tells you to; a reviewer normally maintains it.
>
> **Base check (run FIRST)**:
> `test -f src/core/inventory-v2.ts && test -f src/core/inventory-migration.ts && git log --oneline -1`
> Both files must exist. Your branch must descend from commit `16f432b` on
> `main`. Worktrees in this repository are sometimes provisioned at a stale
> commit — if `git rev-parse HEAD` is not `16f432b` or a descendant, create your
> branch explicitly from `16f432b` and say so in your report.
>
> **Drift check**: `git diff --stat 16f432b..HEAD -- src/core/`
> → expected empty.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW to write (new pure module), HIGH in consequence — this is the
  algorithm that decides whether user data survives
- **Depends on**: `plans/008-inventory-v2-types.md`, `plans/009-inventory-v1-to-v2-migration.md` (both DONE, merged)
- **Category**: bug
- **Planned at**: commit `16f432b`, 2026-09-01

## Why this matters

Today every backend upload serializes this device's whole local document and
writes it over the remote (`src/browser/webdav-service.ts:62-65` and the same
shape in the s3, gitea, and github services). With one device that is fine. With
two, the second device's upload silently erases the first device's records. This
is the only open defect in hsync that destroys user data, and it is the reason
`PLAN.md:229-238`'s Milestone 2 exit condition — "two browser profiles can
safely merge without losing concurrent changes" — is still unmet.

Plans 008–010 built the shape (`InventoryDocumentV2`), the migration
(`liftV1ToV2`), and the read-side projection. This plan writes the piece that
actually fixes the defect: a pure function that folds one device's fresh
observations into the shared union document **without ever touching another
device's state**. Nothing calls it yet; wiring is plan 012.

## Current state

### What the merge consumes

Fresh local observations come from the existing v1 capture, unchanged
(`src/core/inventory.ts:107-130`). It returns an `InventoryDocument` with a flat
`extensions: ExtensionInventoryItem[]`, each item carrying `id`, `browserFamily`,
`name`, `version`, `enabled`, `observedAt`, and optionally `sourceUrl` /
`homepageUrl`. Read that function before starting.

### What the merge produces

`InventoryDocumentV2` from `src/core/inventory-v2.ts` (read it). Recall its
shape: `devices: Record<string, DeviceRecord>` and
`extensions: Record<string, ExtensionRecord>`, where each `ExtensionRecord` has
`aliases`, optional `sources`, optional `homepageUrl`, and
`stateByDevice: Record<string, DeviceExtensionState>`. A `DeviceExtensionState`
is `{ installed, enabled, version, observedAt, deletedAt? }`.

### The specification you are implementing

`docs/design/inventory-schema-v2.md` §4 "Producing a local update". Quoted here
in full because it is the authority and you must match it exactly:

> On every capture/sync cycle, a device D with fresh local observations
> `localExtensions` does, against the latest fetched remote union document
> `remote`:
>
> 1. For each item in `localExtensions`, resolve it to a portable extension id
>    (exact alias match, or create a new `ExtensionRecord` if nothing matches).
>    Write/overwrite `remote.extensions[portableId].stateByDevice[D]` with
>    `{ installed: true, enabled, version, observedAt: now }` (no `deletedAt`).
> 2. For each portable extension id where `remote.extensions[id].stateByDevice[D]`
>    currently exists with `installed: true` but the id was **not** produced in
>    step 1, write a tombstone: `{ installed: false, enabled: false,
>    version: <last known>, observedAt: now, deletedAt: now }`. This is the only
>    way a `deletedAt` is ever set, and it is always set by the same device whose
>    `stateByDevice` entry it belongs to.
> 3. Update `remote.devices[D] = { label, browserFamily, lastSeenAt: now }`.
> 4. Bump `remote.revision` (increment) and `remote.updatedAt = now`.
> 5. Write the result with `expectedVersion` set to the backend version the
>    `remote` was fetched at.

**Step 5 is not yours.** This plan implements steps 1–4 as a pure function. The
write and its conflict retry are plan 012.

### Identity resolution — only step 1 of the ladder

`docs/design/inventory-schema-v2.md` §3 defines a four-step identity ladder.
**Implement only step 1**: "Exact browser-family id match wins. If a newly
observed id already appears in some extension record's `aliases[browserFamily]`
array, that observation updates that record's `stateByDevice` entry for the
reporting device. No user interaction."

If no record has the observed id in `aliases[browserFamily]`, mint a **new**
`ExtensionRecord` (same shape `liftV1ToV2` produces — read
`src/core/inventory-migration.ts:22-53` and match it). Steps 2–4 of the ladder
(user-confirmed aliases, URL proposals, name suggestions) are user-driven UI
work and are explicitly **out of scope**. Do not implement them, do not stub
them, and in particular **never link two records automatically** — §3 says
name-only matches "are never merged automatically."

### The invariant that matters most

> "Each device updates only its own `stateByDevice` entries … It never rewrites
> another device's `stateByDevice` entry and never removes another device's
> `DeviceRecord`."

and:

> "the per-sync merge must never delete a map entry, only add or tombstone one."

Every write your function makes must be keyed by the merging device's own id.
Pruning is a separate, explicit, user-confirmed action and is **not** in this
plan. If your implementation contains a `delete` on `devices` or `extensions`,
it is wrong.

### Conventions and TypeScript strictness

`tsconfig.json:5-6` sets `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. So `record.stateByDevice[deviceId]` is
`DeviceExtensionState | undefined` and must be narrowed, and you may not assign
`undefined` to an optional property — use conditional spread, as
`src/core/inventory-migration.ts:34-39` does. No `as any`; `tsconfig.json` is
out of scope.

The core modules are pure and do not self-validate (see `src/core/inventory.ts`).
Follow that: no runtime validation calls inside the merge, assert validity in
tests instead.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install`) |
| Typecheck | `npm run typecheck` | exit 0, no output |
| All tests | `npm test` | exit 0 (84 tests pass at the time of writing) |
| One test file | `npm test -- tests/inventory-merge.test.ts` | exit 0 |
| Build | `npm run build` | exit 0 |

## Scope

**In scope** (the only files you may create or modify):

- `src/core/inventory-merge.ts` (create)
- `tests/inventory-merge.test.ts` (create)

**Out of scope** — do NOT touch:

- `src/core/inventory.ts`, `src/core/inventory-v2.ts`,
  `src/core/inventory-migration.ts`, `src/core/inventory-projection.ts`,
  `src/core/diff.ts` — all four are finished and merged. If one appears to need a
  change, that is a STOP condition.
- Anything under `src/browser/`, `entrypoints/`, `src/backends/` — the backend
  write, the conflict retry, and the service wiring are plan 012 and plan 013.
- **Pruning** (`docs/design/inventory-schema-v2.md` §4 "Pruning") — a separate
  user-confirmed maintenance action. Not here.
- **Identity-resolution steps 2–4** and any alias-confirmation UI (§3).
- `tsconfig.json`.

## Git workflow

- Branch: `advisor/011-inventory-v2-merge`, from `16f432b`.
- Conventional commits, e.g. `feat: merge per-device observations into the v2 union`.
- Do NOT push or open a PR.

## Steps

### Step 1: Create `src/core/inventory-merge.ts`

Exported signature:

```ts
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

export function mergeLocalObservation(
  input: MergeLocalObservationInput,
): InventoryDocumentV2
```

Defaults: `now = () => new Date()`, `newExtensionId = () => crypto.randomUUID()`
(matching `src/core/inventory-migration.ts:59-60` and `src/browser/device.ts:23`).

The device id and browser family come from `input.local.device`
(`id`, `label`, `browserFamily`). Compute `const timestamp = now().toISOString()`
**once** and use that single value for every `observedAt`, `deletedAt`,
`lastSeenAt`, and `updatedAt` this merge writes — the same discipline
`captureInventory` uses at `src/core/inventory.ts:116`.

**The function must be pure**: do not mutate `input.remote` or any object
reachable from it. Build and return a new document. A reviewer will check this
explicitly, and there is a test for it (case 12).

Implementation outline:

1. Build a lookup from observed browser-family id → existing portable id, by
   scanning `remote.extensions` once: for each `[portableId, record]`, for each
   id in `record.aliases[localBrowserFamily] ?? []`, map `id → portableId`. If
   the same browser id somehow appears under two portable ids, prefer the first
   in iteration order and do not throw — the document is malformed but the merge
   must not lose the observation.
2. For each item in `local.extensions`: resolve its portable id from the lookup,
   or mint one with `newExtensionId()`. Record the resolved id in a `Set` of
   "ids observed this cycle" (needed for step 3).
   - **Matched an existing record**: keep its `name`, `aliases`, `sources`, and
     `homepageUrl` as they are — this device does not get to rename or re-source
     another device's record — and set only
     `stateByDevice[deviceId] = { installed: true, enabled, version, observedAt: timestamp }`.
     Note there is deliberately no `deletedAt` key; a re-installed extension's
     tombstone must disappear, not linger.
   - **No match**: create a new `ExtensionRecord` exactly as
     `src/core/inventory-migration.ts:22-53` builds one — `name`, `aliases` with
     this family's single id, `sources` only when `sourceUrl` is a non-empty
     string, `homepageUrl` only when defined — with the same single
     `stateByDevice` entry.
3. Tombstones. For every `[portableId, record]` in `remote.extensions` **not** in
   the observed set: if `record.stateByDevice[deviceId]` exists and has
   `installed === true`, replace that one entry with
   `{ installed: false, enabled: false, version: <the existing entry's version>,
   observedAt: timestamp, deletedAt: timestamp }`. Leave every other device's
   entry, and every other field of the record, untouched. If the entry does not
   exist, or is already `installed: false`, leave the record completely alone —
   do not refresh an existing tombstone's timestamps.
4. Devices: copy `remote.devices` and set
   `devices[deviceId] = { label: local.device.label, browserFamily, lastSeenAt: timestamp }`.
   Every other device record passes through unchanged.
5. `revision`: increment. Parse with `Number(remote.revision)`; if the result is
   not a finite non-negative integer, treat the current value as `0`. Return
   `String(parsed + 1)`. (A non-numeric revision means a foreign or corrupted
   writer; recovering to a usable counter beats throwing, since the backend's own
   `version` token is what actually protects the write.)
6. `updatedAt` = `timestamp`. `schemaVersion` = `INVENTORY_SCHEMA_VERSION_V2`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Write `tests/inventory-merge.test.ts`

See "Test plan" below.

**Verify**: `npm test -- tests/inventory-merge.test.ts` → exit 0.

### Step 3: Full verification

**Verify**:
- `npm test` → exit 0, every pre-existing test still passes.
- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `git diff 16f432b..HEAD -- src/core/inventory.ts src/core/inventory-v2.ts src/core/inventory-migration.ts src/core/inventory-projection.ts src/core/diff.ts` → empty.
- `grep -cE "delete |\.splice\(" src/core/inventory-merge.ts` → `0`.

## Test plan

Create `tests/inventory-merge.test.ts`, modeled on `tests/diff.test.ts` and
`tests/inventory-migration.test.ts` (read both). Use injected `now` and
`newExtensionId` so every assertion is exact.

Build a two-device v2 fixture: device `laptop` (chromium) and device `phone`
(firefox), with a few extension records — at least one observed by both devices,
one by `laptop` only, and one by `phone` only. Build v1 capture fixtures with
`captureInventory`'s output shape (a plain `InventoryDocument` literal is fine).

Required cases:

1. **New observation, existing record**: an extension whose id is already in
   `aliases.chromium` updates that record's `stateByDevice.laptop` and does
   **not** create a second record. Assert `Object.keys(result.extensions)` is
   unchanged.
2. **New observation, no match**: an unknown id mints exactly one new record with
   the injected id, `aliases.chromium === [thatId]`, and one `stateByDevice`
   entry.
3. **`sources` and `homepageUrl` on a new record** follow the v1 item, with the
   keys omitted when absent — same rule as `liftV1ToV2`.
4. **THE CRITICAL CASE — another device's state is never touched.** After merging
   `laptop`'s capture, every `stateByDevice.phone` entry in the result is
   deep-equal to the one in the input document. Assert this across all records,
   not just one.
5. **Another device's `DeviceRecord` is untouched**: `result.devices.phone`
   deep-equals the input's.
6. **Tombstone**: an extension present in `stateByDevice.laptop` with
   `installed: true`, absent from the new capture, becomes
   `{ installed: false, enabled: false, version: <previous version>,
   observedAt: <now>, deletedAt: <now> }`.
7. **Tombstones are per-device**: the same record's `stateByDevice.phone` still
   reads `installed: true` after `laptop` tombstones its own entry.
8. **No tombstone refresh**: merging twice in a row with the extension still
   absent leaves the first tombstone's `deletedAt` unchanged the second time
   (inject a different `now` for the second merge and assert the timestamp did
   not move).
9. **Re-install clears the tombstone**: after case 6, a capture that includes the
   extension again yields `installed: true` with **no** `deletedAt` property
   (`expect('deletedAt' in state).toBe(false)`).
10. **An extension this device never saw is left alone**: the `phone`-only
    record is byte-identical in the output of a `laptop` merge — no
    `stateByDevice.laptop` key is added to it.
11. **Device record and counters**: `result.devices.laptop.lastSeenAt`,
    `result.updatedAt` both equal the injected timestamp; `revision` goes
    `'7'` → `'8'`; a `revision` of `'not-a-number'` becomes `'1'`.
12. **Purity**: deep-clone the input document before the call
    (`structuredClone`), and assert the original is deep-equal to the clone
    afterwards. The merge must not mutate its input.
13. **Result validity**: `isInventoryDocumentV2(result)` is `true`, including its
    referential-integrity rule that every `stateByDevice` key exists in
    `devices`.
14. **THE REGRESSION TEST FOR THE ACTUAL BUG — offline device cannot resurrect.**
    Simulate the interleaving from `docs/design/inventory-schema-v2.md` §1:
    device `phone` removes an extension (merge `phone`'s capture without it,
    producing a `phone` tombstone), then device `laptop` — which still has a
    stale local view that includes it — merges its own capture against that
    result. Assert the `phone` tombstone survives untouched. Under v1 this is
    exactly the case where `phone`'s deletion was silently undone.
15. **Empty local capture**: a device reporting zero extensions tombstones all of
    its own previously-installed entries and touches nothing else.
16. **Empty remote**: merging against a document with `devices: {}` and
    `extensions: {}` produces a valid single-device document equivalent in shape
    to a `liftV1ToV2` result (do not assert id equality — ids are minted).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, every pre-existing test still passing
- [ ] `npm test -- tests/inventory-merge.test.ts` exits 0 covering all 16 cases
- [ ] `npm run build` exits 0
- [ ] `git diff 16f432b..HEAD -- src/core/` shows only the two new files
- [ ] `grep -c "as any" src/core/inventory-merge.ts` returns 0
- [ ] `grep -cE "delete |\.splice\(" src/core/inventory-merge.ts` returns 0
- [ ] `git status --short` lists exactly the two new files

## STOP conditions

Stop and report back (do not improvise) if:

- `src/core/inventory-v2.ts` or `src/core/inventory-migration.ts` is missing —
  your worktree is on the wrong base.
- You conclude the merge cannot be written without modifying one of the finished
  core modules.
- You find yourself needing to delete a `devices` or `extensions` entry, or to
  write into a `stateByDevice` key other than the merging device's own. Both
  violate the design's central invariant; report what forced it.
- You are tempted to implement identity-resolution steps 2–4 (URL or name
  matching) to make a test pass. Report it instead — automatic linking is
  explicitly forbidden by §3.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

- **Nothing calls this when it lands.** Plan 012 adds the backend orchestration
  (fetch → merge → conditional write → re-fetch-and-redo on conflict).
- The conflict retry in plan 012 depends on a property this function must have:
  redoing the whole merge against a freshly fetched remote is always safe,
  because every write is scoped to this device's own keys. If a future change
  makes the merge read another device's state to decide its own output, that
  property breaks and the retry becomes unsound.
- A reviewer should read case 4 and case 14 first — they are the two that
  actually encode "we stopped destroying data."
- Deliberately deferred: pruning, identity-resolution steps 2–4, the
  alias-confirmation UI, and encryption. All tracked in
  `docs/design/inventory-schema-v2.md`.
