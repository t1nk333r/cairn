# Plan 009: Lift an existing v1 inventory document into the v2 multi-device shape

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Base check (run FIRST, before anything else)**:
> `test -f src/core/inventory-v2.ts && grep -n "INVENTORY_SCHEMA_VERSION_V2" src/core/inventory-v2.ts`
> If that file does not exist, **STOP immediately and report**. This plan builds
> directly on plan 008 and cannot run against a checkout that lacks it. Your
> branch must be created from `advisor/008-inventory-v2-types`, not from `main`.
>
> **Drift check**: `git diff --stat b11f485..HEAD -- src/core/inventory.ts`
> → expected empty. If `src/core/inventory.ts` has changed, compare the
> "Current state" excerpts against the live code before proceeding.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (additive — one new module, one new test file)
- **Depends on**: `plans/008-inventory-v2-types.md` (hard dependency)
- **Category**: migration
- **Planned at**: commit `b11f485`, 2026-09-01

## Why this matters

Every hsync user who has ever synced has a v1 document sitting in their WebDAV
share, S3 bucket, or Git repository. v2 (plan 008) defines a better shape, but
without a lift function that shape can only ever describe *new* inventories —
existing users would have to throw their history away, and the "Upgrade to
multi-device inventory" action described in `docs/design/inventory-schema-v2.md`
§5 would have nothing to call.

This plan writes that lift: a pure function turning one v1 document into an
equivalent single-device v2 document, with no data loss beyond one documented
field. It is small, it is pure, and it is the piece the upgrade path is built
on. Nothing calls it when the plan lands — the upgrade action is a later plan.

## Current state

### What you are converting FROM (`src/core/inventory.ts:1-31`)

```ts
export const INVENTORY_SCHEMA_VERSION = 1 as const;

export type BrowserFamily = 'chromium' | 'firefox';

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

### What you are converting TO

The interfaces added by plan 008 in `src/core/inventory-v2.ts`:
`InventoryDocumentV2`, `DeviceRecord`, `ExtensionRecord`, `DeviceExtensionState`,
and the constant `INVENTORY_SCHEMA_VERSION_V2`. Open that file and read it
before writing code.

### The reference implementation, from the design doc

`docs/design/inventory-schema-v2.md` §5 "Lifting a v1 remote to v2" gives this
sketch. It is the authority for the field mapping, but it is a sketch — it does
not satisfy this repo's `exactOptionalPropertyTypes` setting, and you must
handle the optional fields as described in "Step 1" below.

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
        newPortableId(), // freshly minted
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

### Two decisions the design doc leaves to this plan

**1. Portable extension ids.** `docs/design/inventory-schema-v2.md` §7.1
recommends "a randomly generated id (ULID or UUIDv4) minted once when an
`ExtensionRecord` is first created … and never recomputed. A deterministic id
derived from the first-seen alias would have to change if that alias later needs
correcting." Follow that recommendation. The repo already mints ids with
`crypto.randomUUID()` — see `src/browser/device.ts:23`, which uses it for the
device id. Use the same call; do not add a dependency.

**2. `browserName` is dropped.** v1's `DeviceObservation` carries both `label`
and `browserName` (`inventory.ts:5-10`); v2's `DeviceRecord` carries only
`label`. This is not an oversight in the design — `PLAN.md:72-78` specifies the
same three-field device record. The loss is acceptable because `label` already
defaults to the detected browser name: `src/browser/device.ts:24-27` sets
`label = detectBrowserName(navigator.userAgent)` when the user has not chosen
one. Drop `browserName` silently; do not invent a v2 field for it.

### TypeScript strictness — read before writing code

`tsconfig.json:5-6` sets `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`. The second one breaks the design-doc sketch above
in two places:

- `homepageUrl: item.homepageUrl` assigns `string | undefined` to
  `homepageUrl?: string`. **Type error.** Use conditional spread:
  `...(item.homepageUrl !== undefined ? { homepageUrl: item.homepageUrl } : {})`.
- A computed key like `{ [item.browserFamily]: [item.id] }` infers as
  `{ [x: string]: string[] }`, which does not satisfy
  `Partial<Record<BrowserFamily, string[]>>` cleanly in all positions. Build it
  explicitly, e.g. `const aliases: Partial<Record<BrowserFamily, string[]>> = { [item.browserFamily]: [item.id] };`
  with the annotation on the binding.

Do not reach for `as any` or edit `tsconfig.json` — both are out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install`) |
| Typecheck | `npm run typecheck` | exit 0, no output |
| All tests | `npm test` | exit 0 |
| One test file | `npm test -- tests/inventory-migration.test.ts` | exit 0 |
| Build | `npm run build` | exit 0 |

## Scope

**In scope** (the only files you may create or modify):

- `src/core/inventory-migration.ts` (create)
- `tests/inventory-migration.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope** — do NOT touch:

- `src/core/inventory.ts` — v1 must stay byte-identical; it is still the
  shipping format for every backend.
- `src/core/inventory-v2.ts` — plan 008 owns it. If you believe it needs a
  change, that is a STOP condition, not an edit.
- `src/core/diff.ts` — plan 010 covers the projection it needs.
- Anything under `src/browser/`, `entrypoints/`, or `src/backends/` — the
  "Upgrade to multi-device inventory" UI action and the service cutover are
  deliberately later plans.
- The **merge algorithm** (`docs/design/inventory-schema-v2.md` §4). The design
  doc mentions putting it in this same module eventually. Do not write it here.
  Merging two v2 documents is a substantially harder problem with its own
  conflict semantics and deserves its own plan and its own review.

## Git workflow

- Branch: `advisor/009-inventory-v1-to-v2-migration`, created **from
  `advisor/008-inventory-v2-types`** — not from `main`.
- Conventional commits, e.g. `feat: lift v1 inventories into the v2 shape`.
- Do NOT push or open a PR.

## Steps

### Step 1: Create `src/core/inventory-migration.ts` with `liftV1ToV2`

Exported signature:

```ts
export interface LiftV1ToV2Options {
  /** Mints a fresh portable extension id. Injectable for deterministic tests. */
  newExtensionId?: () => string;
}

export function liftV1ToV2(
  document: InventoryDocument,
  options?: LiftV1ToV2Options,
): InventoryDocumentV2
```

Default `newExtensionId` to `() => crypto.randomUUID()`. The parameter exists so
tests can assert exact output; production callers omit it.

Field mapping, exactly:

| v2 field | Source |
|---|---|
| `schemaVersion` | `INVENTORY_SCHEMA_VERSION_V2` |
| `revision` | `'1'` — a lifted document is the first revision of its v2 history |
| `updatedAt` | `document.generatedAt` |
| `devices[document.device.id].label` | `document.device.label` |
| `devices[…].browserFamily` | `document.device.browserFamily` |
| `devices[…].lastSeenAt` | `document.generatedAt` |
| extension record key | `newExtensionId()`, one call per extension |
| `.name` | `item.name` |
| `.aliases` | `{ [item.browserFamily]: [item.id] }` |
| `.sources` | `{ [item.browserFamily]: item.sourceUrl }` when `sourceUrl` is a non-empty string; otherwise **omit the `sources` key entirely** |
| `.homepageUrl` | `item.homepageUrl` when defined; otherwise omit the key |
| `.stateByDevice[deviceId].installed` | always `true` — a v1 document only lists extensions that were installed at capture time (`src/core/inventory.ts:117-119` filters `management.getAll()`) |
| `.stateByDevice[deviceId].enabled` | `item.enabled` |
| `.stateByDevice[deviceId].version` | `item.version` |
| `.stateByDevice[deviceId].observedAt` | `item.observedAt` |
| `.stateByDevice[deviceId].deletedAt` | never set — a lift produces no tombstones |

Fields intentionally **not** carried across: `browserName` (see "Current state"),
and `type`, `installType`, `updateUrl` — v2's `ExtensionRecord`
(`docs/design/inventory-schema-v2.md` §2) has no home for them. `type` is
already invariant in practice (`inventory.ts:118` keeps only
`type === 'extension'`). If you think one of the other two must survive, that is
a STOP condition — do not add a field to the v2 interfaces on your own
initiative.

Note the design doc's sketch writes `sources: {}` for an extension with no
source URL. Prefer omitting the optional key instead: it keeps the serialized
JSON smaller and the Git diffs quieter, and `sources` is declared optional in
plan 008's interface. Be consistent — assert whichever you choose in the tests.

Add a short file-header comment naming the design doc section this implements.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Guarantee the output actually validates

The whole point of the lift is to produce a document the rest of the system will
accept. Import `isInventoryDocumentV2` from `./inventory-v2` in your **test
file** and assert it returns `true` for every lift result. (Assert it in tests,
not as a runtime check inside `liftV1ToV2` — the repo's core functions are pure
and do not self-validate; see `src/core/inventory.ts` for the pattern.)

**Verify**: covered by step 3's test run.

### Step 3: Write `tests/inventory-migration.test.ts`

See "Test plan" below.

**Verify**: `npm test -- tests/inventory-migration.test.ts` → exit 0.

### Step 4: Full verification

**Verify**:
- `npm test` → exit 0, all pre-existing tests still pass, including
  `tests/inventory-characterization.test.ts` and `tests/inventory-v2.test.ts`.
- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `git status --short` → only your two new files plus the `plans/README.md` row.

## Test plan

Create `tests/inventory-migration.test.ts`. Model its structure on
`tests/diff.test.ts` (read it first) — `import { describe, expect, it } from 'vitest';`,
module-scope factory helpers, no mocks.

Build a v1 fixture using the real v1 types imported from `../src/core/inventory`:
one device, and three extensions — one Chromium extension with a `sourceUrl`,
one with **no** `sourceUrl` and no `homepageUrl`, and one disabled
(`enabled: false`).

Inject a deterministic id generator so output is assertable:

```ts
const sequentialIds = () => {
  let n = 0;
  return () => `ext-${++n}`;
};
```

Required cases:

1. **Shape**: the result has `schemaVersion === 2`, `revision === '1'`, and
   `updatedAt` equal to the v1 `generatedAt`.
2. **Validity**: `isInventoryDocumentV2(result)` is `true` (imported from
   `../src/core/inventory-v2`).
3. **Single device**: `Object.keys(result.devices)` has length 1 and equals
   `[v1.device.id]`; that record's `lastSeenAt` equals the v1 `generatedAt` and
   its `label` equals the v1 device label.
4. **`browserName` is gone**: the device record has no `browserName` property
   (`expect('browserName' in record).toBe(false)`).
5. **One record per extension**: `Object.keys(result.extensions)` has length 3
   and equals `['ext-1', 'ext-2', 'ext-3']` with the injected generator.
6. **Aliases**: the Chromium extension's record has
   `aliases.chromium === [<original v1 id>]` and no `firefox` key.
7. **Sources**: the extension that had a `sourceUrl` carries it under
   `sources.chromium`; the one that had none omits `sources` entirely (or is
   `{}` — assert whichever step 1 implemented, consistently).
8. **State**: every lifted `stateByDevice` entry has `installed: true`, carries
   the v1 `enabled` value (verify the disabled extension yields
   `enabled: false`), the v1 `version`, and the v1 `observedAt` — **not** a
   freshly generated timestamp.
9. **No tombstones**: no `stateByDevice` entry has a `deletedAt` property.
10. **Empty inventory**: lifting a v1 document with `extensions: []` yields a
    valid v2 document with one device and `extensions` equal to `{}`.
11. **Round trip**: `parseInventoryJsonV2(serializeInventoryV2(liftV1ToV2(fixture)))`
    deep-equals the lift result (both imported from `../src/core/inventory-v2`).
    This proves a lifted document survives a real write/read cycle.
12. **Default generator**: calling `liftV1ToV2(fixture)` with no options produces
    ids that are all distinct and all non-empty strings. (Do not assert UUID
    formatting — assert distinctness and that `Object.keys(...).length === 3`.)

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, with every pre-existing test still passing
- [ ] `npm test -- tests/inventory-migration.test.ts` exits 0 covering all 12 cases
- [ ] `npm run build` exits 0
- [ ] `git status --short` lists exactly `src/core/inventory-migration.ts` and `tests/inventory-migration.test.ts` as new, plus the `plans/README.md` edit
- [ ] `git diff -- src/core/inventory.ts src/core/inventory-v2.ts` produces empty output
- [ ] `grep -c "as any" src/core/inventory-migration.ts` returns 0
- [ ] `grep -c "mergeInventor\|merge(" src/core/inventory-migration.ts` returns 0 — the merge algorithm is explicitly not in this plan
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `src/core/inventory-v2.ts` does not exist, or does not export
  `INVENTORY_SCHEMA_VERSION_V2`, `InventoryDocumentV2`, and
  `isInventoryDocumentV2`. Your worktree was branched from the wrong base.
- The v1 excerpts above no longer match `src/core/inventory.ts`.
- You conclude that a v1 field you were told to drop (`browserName`, `type`,
  `installType`, `updateUrl`) must survive the lift. Report the reasoning; do
  not add fields to the v2 interfaces.
- `isInventoryDocumentV2` returns `false` for a lift result and you cannot fix it
  without editing `src/core/inventory-v2.ts`. That means plan 008's validator and
  this plan's mapping disagree, and a human needs to decide which is right.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

For whoever owns this next:

- **Nothing calls `liftV1ToV2` when this lands.** Its intended first caller is
  the "Upgrade to multi-device inventory" action described in
  `docs/design/inventory-schema-v2.md` §5, which must pull the remote, lift it,
  and write it back **using the `expectedVersion` from that same pull** so the
  upgrade write is protected by the same optimistic-concurrency check as any
  other write. That sequencing is the single most important thing for the next
  implementer to get right; an unconditional upgrade write would overwrite a
  concurrent change during the migration itself.
- Per §5 there is deliberately **no downgrade path**. Collapsing v2 back to v1
  would discard devices and tombstone history. Once a backend's remote is
  upgraded it stays upgraded.
- A reviewer should check that `observedAt` is carried through from v1 rather
  than regenerated — regenerating it would fabricate observation history, and it
  is an easy mistake to make while writing this function.
- Deferred out of this plan, by design: the merge algorithm (§4), identity
  resolution and alias confirmation (§3), pruning (§4), and the upgrade UI (§5).
