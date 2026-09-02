# Plan 008: Add the v2 multi-device inventory types, validator, parser, and canonical serializer

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat b11f485..HEAD -- src/core/ tests/ docs/design/inventory-schema-v2.md`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW (purely additive — no existing file is modified)
- **Depends on**: none (design input is `docs/design/inventory-schema-v2.md`, already committed)
- **Category**: migration
- **Planned at**: commit `b11f485`, 2026-09-01

## Why this matters

hsync's inventory document holds exactly **one** device (`src/core/inventory.ts:26-31`).
When a second browser profile uploads, it writes its whole local document over
the remote, and the first device's records are gone. There is no merge, no
per-device state, and no tombstones. This is the only open defect in the project
that silently destroys user data, and it also blocks two other things: Firefox
and Chromium inventories can never be compared (`src/core/diff.ts:24-25` keys
every extension as `` `${browserFamily}:${id}` ``, so no cross-family entry can
ever match), and encryption cannot be designed against a document shape that is
about to change.

`docs/design/inventory-schema-v2.md` specifies the replacement shape. This plan
lands **only the v2 data layer**: types, a validator, a parser, and a canonical
serializer, in a brand-new file. Nothing calls it yet. That is deliberate — it
makes this step reviewable in isolation and impossible to regress existing
behavior with, because no existing file is touched.

## Current state

Files you need to know about:

- `src/core/inventory.ts` — the v1 schema, capture, validator, parser, canonical
  serializer. **You will not modify this file.** You will import two things from
  it: the `BrowserFamily` type and the `InventoryFormatError` class.
- `src/core/diff.ts` — v1 comparison. Not touched by this plan.
- `tests/inventory-characterization.test.ts` — pins current v1 behavior,
  including that `parseInventoryJson` rejects `schemaVersion: 2`. **This test
  must keep passing unchanged.** It is the safety net proving this plan did not
  disturb v1.
- `docs/design/inventory-schema-v2.md` — the design this plan implements.

### The v1 error class you will reuse (`src/core/inventory.ts:55-66`)

```ts
export class InventoryFormatError extends Error {
  constructor(
    public readonly code:
      | 'invalid_json'
      | 'invalid_inventory'
      | 'unsupported_schema',
    message: string,
  ) {
    super(message);
    this.name = 'InventoryFormatError';
  }
}
```

### The v1 parser you will mirror in structure (`src/core/inventory.ts:159-196`)

```ts
export function parseInventoryJson(text: string): InventoryDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InventoryFormatError(
      'invalid_json',
      'The selected file is not valid JSON.',
    );
  }

  if (
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    (value as { schemaVersion?: unknown }).schemaVersion !==
      INVENTORY_SCHEMA_VERSION
  ) {
    throw new InventoryFormatError(
      'unsupported_schema',
      `This inventory uses unsupported schema version ${String((value as { schemaVersion?: unknown }).schemaVersion)}.`,
    );
  }

  if (!isInventoryDocument(value)) {
    throw new InventoryFormatError(
      'invalid_inventory',
      'The selected JSON file is not a valid hsync inventory.',
    );
  }

  return { /* sorted copy */ };
}
```

### The v1 canonical serializer (`src/core/inventory.ts:198-208`)

```ts
export function serializeInventory(inventory: InventoryDocument): string {
  const canonical: InventoryDocument = {
    ...inventory,
    extensions: [...inventory.extensions].sort((left, right) =>
      `${left.browserFamily}:${left.id}`.localeCompare(
        `${right.browserFamily}:${right.id}`,
      ),
    ),
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
```

Note the two conventions it establishes and which your v2 serializer must also
honor: **deterministic ordering before stringify**, and **two-space indent with
a trailing newline**. Determinism exists because these documents are committed
to Git repositories (Gitea/GitHub backends) and must produce readable diffs.

### TypeScript strictness — read this before writing code

`tsconfig.json:5-6` enables:

```json
"noUncheckedIndexedAccess": true,
"exactOptionalPropertyTypes": true
```

Two consequences you **will** hit in this plan:

1. `doc.devices[someId]` has type `DeviceRecord | undefined`, never
   `DeviceRecord`. You must narrow with an explicit `if (!record) …` before use.
   Destructuring a `Record<string, T>` in a `for…of Object.entries()` loop is
   fine — entries are typed `[string, T]`.
2. You may **not** assign `undefined` to an optional property. `{ deletedAt: undefined }`
   is a type error against `deletedAt?: string`. Use conditional spread instead:
   `...(value !== undefined ? { deletedAt: value } : {})`. The v1 code solves the
   same problem with a `defined()` helper at `src/core/inventory.ts:70-74`; you
   do not need to reuse it, but do not fight the compiler by widening types or
   adding `as any`.

### The target v2 shape, from the design doc

Quoted from `docs/design/inventory-schema-v2.md` §2, which is the authority for
this plan. Reproduce these interfaces exactly (names included):

```ts
export const INVENTORY_SCHEMA_VERSION_V2 = 2 as const;

export interface DeviceRecord {
  label: string;
  browserFamily: BrowserFamily;
  lastSeenAt: string; // ISO 8601
}

export interface DeviceExtensionState {
  installed: boolean;
  enabled: boolean;
  version: string;
  observedAt: string;
  deletedAt?: string;
}

export interface ExtensionRecord {
  name: string;
  aliases: Partial<Record<BrowserFamily, string[]>>;
  sources?: Partial<Record<BrowserFamily, string>>;
  homepageUrl?: string;
  stateByDevice: Record<string, DeviceExtensionState>;
}

export interface InventoryDocumentV2 {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION_V2;
  revision: string;
  updatedAt: string;
  devices: Record<string, DeviceRecord>;
  extensions: Record<string, ExtensionRecord>;
}
```

**One deliberate deviation from the design doc, and why.** The doc's "Files that
change" section says `INVENTORY_SCHEMA_VERSION` in `src/core/inventory.ts`
"becomes 2" and that the v1 functions get renamed. **Do not do that in this
plan.** Flipping the constant would change what `captureInventory` stamps on
every document, which would immediately break all five backend services and the
options page — none of which understand v2 yet. Instead this plan introduces a
separate `INVENTORY_SCHEMA_VERSION_V2` constant in a separate file, leaving v1
untouched and fully working. The cutover happens in a later plan, once the merge
algorithm and the "Upgrade to multi-device inventory" action exist. If you find
yourself editing `src/core/inventory.ts`, you have left this plan's scope.

A worked example of a valid v2 document is in `docs/design/inventory-schema-v2.md`
§2 "JSON example" — read it before writing the validator.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install` — a partial install previously left this repo unbuildable) |
| Typecheck | `npm run typecheck` | exit 0, no output |
| All tests | `npm test` | exit 0, all files pass |
| One test file | `npm test -- tests/inventory-v2.test.ts` | exit 0 |
| Build (Chromium) | `npm run build` | exit 0 |

## Scope

**In scope** (the only files you may create or modify):

- `src/core/inventory-v2.ts` (create)
- `tests/inventory-v2.test.ts` (create)
- `plans/README.md` (status row only)

**Out of scope** — do NOT touch, even though they look related:

- `src/core/inventory.ts` — v1 must stay byte-identical. See the deviation note
  above. Every currently shipping code path depends on it.
- `src/core/diff.ts` — a later plan adds the v2 projection it needs.
- `tests/inventory-characterization.test.ts` — this is the safety net that
  proves you didn't disturb v1. If it needs changing, you broke something.
- Any file under `src/browser/`, `entrypoints/`, or `src/backends/` — nothing
  consumes v2 yet, and wiring it up is a separate plan.
- `docs/design/inventory-schema-v2.md` — it is the input, not the output.

## Git workflow

- Branch: `advisor/008-inventory-v2-types`, created from `b11f485` (or current
  `main` if it has advanced and the drift check passed).
- Commit style is conventional commits — see `git log --oneline -5`, e.g.
  `feat: add keyring-backed Git authentication`. Use
  `feat: add v2 multi-device inventory schema types`.
- Do NOT push or open a PR.

## Steps

### Step 1: Create `src/core/inventory-v2.ts` with the types and constant

Create the file. Import `BrowserFamily` as a type and `InventoryFormatError` as
a value from `./inventory`:

```ts
import { InventoryFormatError, type BrowserFamily } from './inventory';
```

Then declare `INVENTORY_SCHEMA_VERSION_V2` and the five exported interfaces
exactly as given in "Current state" above. Add a file-header comment (2–4 lines)
stating that this is the v2 multi-device schema, that v1 in `./inventory` is
still the shipping format, and pointing to `docs/design/inventory-schema-v2.md`.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add the `isInventoryDocumentV2` type guard

Signature: `export function isInventoryDocumentV2(value: unknown): value is InventoryDocumentV2`

It must return `false` unless **all** of the following hold. Model the style on
the v1 guard at `src/core/inventory.ts:132-157` (flat boolean checks, no
throwing, no external validation library — the repo has none).

- `value` is a non-null object.
- `schemaVersion === 2`.
- `revision` and `updatedAt` are both `string`.
- `devices` is a non-null, non-array object, and every value in it has:
  `label: string`, `lastSeenAt: string`, and `browserFamily` equal to
  `'chromium'` or `'firefox'`.
- `extensions` is a non-null, non-array object, and every value in it has:
  - `name: string`;
  - `aliases`: a non-null object with **at least one** key, every key being
    `'chromium'` or `'firefox'`, and every value an array of `string` with at
    least one element;
  - `sources`, when present: a non-null object whose keys are browser families
    and whose values are `string`;
  - `homepageUrl`, when present: a `string`;
  - `stateByDevice`: a non-null object where every value has
    `installed: boolean`, `enabled: boolean`, `version: string`,
    `observedAt: string`, and — when present — `deletedAt: string`.
- **Referential integrity**: every device id used as a key in any record's
  `stateByDevice` also exists as a key in the top-level `devices` map. A
  document referencing an unknown device is corrupt and must be rejected.

Use `Array.isArray(x)` to exclude arrays, since `typeof [] === 'object'`.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add `parseInventoryJsonV2`

Signature: `export function parseInventoryJsonV2(text: string): InventoryDocumentV2`

Mirror the v1 parser's three-stage structure (excerpt in "Current state"),
substituting the v2 constant and guard:

1. `JSON.parse` failure → `new InventoryFormatError('invalid_json', 'The selected file is not valid JSON.')`.
2. The value is an object carrying a `schemaVersion` that is **not** `2` →
   `new InventoryFormatError('unsupported_schema', ...)` with the same message
   wording as v1: `` `This inventory uses unsupported schema version ${String(actual)}.` ``
3. `!isInventoryDocumentV2(value)` → `new InventoryFormatError('invalid_inventory', 'The selected JSON file is not a valid hsync inventory.')`.

Return the parsed value. Unlike v1 there is no re-sorting on read — v2 stores
maps, not arrays, and ordering is imposed on write by step 4.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Add `serializeInventoryV2` with deterministic key ordering

Signature: `export function serializeInventoryV2(document: InventoryDocumentV2): string`

`JSON.stringify` emits object keys in insertion order, so a v2 document
serialized naively would produce a different byte sequence depending on the
order records happened to be added — defeating the readable-Git-diff goal stated
in `PLAN.md:64-66` and implemented for v1 at `src/core/inventory.ts:198-208`.

Rebuild every map with its keys sorted before stringifying. Write one small
local helper and use it at all three levels:

```ts
function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}
```

Apply it to: the top-level `devices` map, the top-level `extensions` map, and
each `ExtensionRecord`'s `stateByDevice` map. Also sort each `aliases` array
(`[...ids].sort()`), for the same reason.

Return `` `${JSON.stringify(canonical, null, 2)}\n` `` — two-space indent and a
trailing newline, matching v1 exactly.

Do not reorder or drop the top-level scalar fields; keep them in declaration
order (`schemaVersion`, `revision`, `updatedAt`, `devices`, `extensions`).

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Write `tests/inventory-v2.test.ts`

See "Test plan" below for the required cases.

**Verify**: `npm test -- tests/inventory-v2.test.ts` → exit 0, all listed cases
pass.

### Step 6: Confirm v1 is untouched

**Verify**:
- `git diff --stat b11f485..HEAD -- src/core/inventory.ts src/core/diff.ts tests/inventory-characterization.test.ts` → **empty output**.
- `npm test` → exit 0, every pre-existing test still passes (44 tests passed at
  the time this plan was written; you should see that number plus your new ones).
- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.

## Test plan

Create `tests/inventory-v2.test.ts`. Model the structure on `tests/diff.test.ts`
(read it first): `import { describe, expect, it } from 'vitest';`, a small
factory helper at module scope for building fixtures, then `describe` blocks per
function. No mocking framework is needed.

Build one shared fixture: a valid v2 document with **two** devices and **two**
extension records — one present on both devices and aliased across families
(`chromium` and `firefox` ids), one present on a single device — plus one
tombstoned `stateByDevice` entry (`installed: false` with `deletedAt` set). The
JSON example in `docs/design/inventory-schema-v2.md` §2 is exactly this shape;
use it as the model.

Required cases:

**`isInventoryDocumentV2`**
1. accepts the valid two-device fixture
2. rejects `schemaVersion: 1`
3. rejects a device whose `browserFamily` is neither `chromium` nor `firefox`
4. rejects an extension record whose `aliases` object is empty
5. rejects an extension record whose `aliases.chromium` is an empty array
6. rejects a `stateByDevice` entry missing `observedAt`
7. rejects a `stateByDevice` key that is not present in the top-level `devices`
   map (referential integrity)
8. rejects `null`, a string, and an array

**`parseInventoryJsonV2`**
9. parses the serialized fixture back into a deep-equal document
10. throws `InventoryFormatError` with `code === 'invalid_json'` on `'{'`
11. throws `InventoryFormatError` with `code === 'unsupported_schema'` on a
    document with `schemaVersion: 1` — this is the mirror image of the v1
    behavior pinned in `tests/inventory-characterization.test.ts`
12. throws `InventoryFormatError` with `code === 'invalid_inventory'` on
    `'{"schemaVersion":2}'`

**`serializeInventoryV2`**
13. output ends with exactly one `\n` and uses two-space indentation
14. **determinism**: building the same logical document twice with device and
    extension keys inserted in *opposite* orders produces byte-identical output.
    This is the test that protects the Git-diff property — assert
    `expect(a).toBe(b)` on the two strings.
15. round-trip: `parseInventoryJsonV2(serializeInventoryV2(fixture))` deep-equals
    the fixture (modulo the key ordering that serialization imposes — compare
    with `toEqual`, which ignores key order)

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, with all previously existing tests still passing
- [ ] `npm test -- tests/inventory-v2.test.ts` exits 0 with at least 15 assertions' worth of cases
- [ ] `npm run build` exits 0
- [ ] `git status --short` lists exactly two new files (`src/core/inventory-v2.ts`, `tests/inventory-v2.test.ts`) plus the `plans/README.md` status edit — nothing else
- [ ] `git diff b11f485..HEAD -- src/core/inventory.ts` produces empty output
- [ ] `grep -c "as any" src/core/inventory-v2.ts` returns 0
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above from `src/core/inventory.ts` no longer match the live file.
- `tests/inventory-characterization.test.ts` fails at any point. It exercises
  only v1 code you were told not to touch, so a failure means something is wrong
  with your environment or your understanding of the scope — not something to
  fix by editing that test.
- You conclude the plan requires modifying `src/core/inventory.ts`,
  `src/core/diff.ts`, or anything under `src/browser/` or `entrypoints/`.
- `exactOptionalPropertyTypes` or `noUncheckedIndexedAccess` forces a design you
  believe is wrong. Report the specific compiler error rather than reaching for
  `as any` or loosening `tsconfig.json` — `tsconfig.json` is out of scope.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

For whoever owns this next:

- **Nothing imports this module when the plan lands.** That is intended, not an
  oversight. Plan 009 (lift v1 → v2) and plan 010 (per-device projection) are
  its first consumers; the service and UI cutover comes later still.
- A reviewer should scrutinize two things: that `src/core/inventory.ts` is
  genuinely byte-identical, and that the determinism test (case 14) really does
  insert keys in opposing orders — it is easy to write a version of that test
  that passes trivially.
- Deliberately deferred out of this plan: the merge algorithm
  (`docs/design/inventory-schema-v2.md` §4), portable-id minting (plan 009),
  alias/identity resolution UI (§3), pruning (§4), and the encryption envelope
  (§6). Do not add stubs for any of them.
- The `revision` field is a human-legible counter, deliberately distinct from
  the backend's opaque optimistic-concurrency token in
  `src/backends/contract.ts`. Section 7.2 of the design doc explains why both
  exist; don't "simplify" one away later without reading it.
