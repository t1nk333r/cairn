# Plan 005: Design schema v2 (multi-device inventory) and pin current behavior with characterization tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2f8fe62..HEAD -- src/core/ src/browser/`
> If any file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (for this spike; the implementation it specifies is L)
- **Risk**: LOW (this plan writes tests and a document; it changes no behavior)
- **Depends on**: plans/001-verification-baseline.md
- **Category**: direction
- **Planned at**: commit `2f8fe62`, 2026-08-31

## THIS IS A DESIGN SPIKE — READ THIS FIRST

**Do not implement schema v2 in this plan.** The deliverables are (a) a set of
characterization tests that pin today's behavior, and (b) a design document.
The actual migration is a separate, larger piece of work that this document
will specify and that a human must approve first.

If you find yourself editing `src/core/inventory.ts` to change the document
shape, you have left the plan. Stop.

## Why this matters

The product's premise is comparing and restoring extensions **across devices**.
The remote document cannot represent more than one device.

`InventoryDocument` holds a single `device` and a flat `extensions` array. Every
upload path serializes *this device's whole document* as the entire remote file.
Pull does not merge — it stores what it read as a local comparison baseline.

So with two devices: A uploads, remote = A's document. B pulls (getting a
version token), then uploads, and remote = B's document. **A's inventory is
gone.** Optimistic concurrency does not prevent this; it only forces B to pull
first, and the pull does not merge anything. This is precisely the last-write-wins
behavior the project documents as deliberately avoided.

The planned design in `PLAN.md` specifies a union document — a `devices` map,
portable extension identity with `aliases`, `stateByDevice`, and tombstones. The
code diverged from it. Two consequences follow, and they are why this is urgent
rather than merely untidy:

1. **The next scheduled slice is encryption.** Building an AES-GCM envelope
   around today's single-device document means the shape changes immediately
   afterward, forcing a migration that must decrypt v1, lift to v2, and
   re-encrypt — on remotes users already hold. Settling the schema first makes
   encryption a thin wrapper over a stable format.
2. **Encryption and readable Git history are in tension.** An AES-GCM envelope
   with a fresh nonce per write makes every commit an opaque full-file binary
   change, which destroys the auditable-history property that justifies the
   Git/Gitea/GitHub backends. `PLAN.md` still lists "encrypted by default or
   opt-in" as an open decision; it cannot be answered independently of this one.

## Current state

`src/core/inventory.ts:26-31` — the shipped document. One device, flat array,
no `revision`, no aliases, no per-device state, no tombstones:

```ts
export interface InventoryDocument {
  schemaVersion: typeof INVENTORY_SCHEMA_VERSION;
  generatedAt: string;
  device: DeviceObservation;
  extensions: ExtensionInventoryItem[];
}
```

`src/core/inventory.ts:12-24` — the per-extension record:

```ts
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
```

`src/core/inventory.ts:1` — `INVENTORY_SCHEMA_VERSION = 1 as const`, and
`parseInventoryJson` (lines 159-196) hard-rejects any other value with
`unsupported_schema`. **Any v2 document written today would be rejected by
every currently-installed client.** That is the migration constraint.

`src/core/diff.ts:24-25` — identity is per-browser-family, so a Firefox and a
Chromium copy of the same add-on never match:

```ts
const keyOf = (item: ExtensionInventoryItem) =>
  `${item.browserFamily}:${item.id}`;
```

`src/browser/webdav-service.ts:33-45` — the pull path. Note it saves a
*baseline*, never merging into local state. The other four services
(`s3-service.ts`, `gitea-service.ts`, `github-service.ts`, `native-service.ts`)
follow the identical shape:

```ts
export async function pullWebDavInventory() {
  const backend = await configuredBackend();
  const remote = await backend.read();
  if (!remote) {
    throw new BackendError('not_found', 'No hsync inventory exists at this WebDAV location yet.');
  }
  const inventory = parseInventoryJson(decoder.decode(remote.data));
  await Promise.all([
    saveComparisonBaseline(inventory),
    saveWebDavRemoteVersion(remote.version),
  ]);
  return inventory;
}
```

`src/browser/webdav-service.ts:47-68` — the upload path, which writes the local
document wholesale as the remote file.

The target design is specified in `PLAN.md` under "Inventory schema" (the
`devices` / `aliases` / `stateByDevice` JSON example), "Portable identity
resolution" (the four-step ladder: exact family-ID match, user-confirmed alias,
unique canonical URL proposal, name-only never auto-merged), and "Sync and merge
behavior" ("The remote file is the union of observations, not a mirror of
whichever device wrote last... Deletions are tombstones with timestamps so an
offline device cannot accidentally resurrect removed records. Old device
observations and tombstones are pruned only through an explicit maintenance
action."). **Read those three sections before writing the design document** —
they are the maintainer's stated intent and the design must either follow them
or explicitly argue why not.

Test conventions: vitest, files in `tests/*.test.ts`, plain `expect`. Model the
new file on `tests/inventory.test.ts` and `tests/import-export.test.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0, all pass |
| Focused tests | `npx vitest run tests/inventory-characterization.test.ts` | all pass |

## Scope

**In scope**:
- `tests/inventory-characterization.test.ts` (create)
- `docs/design/inventory-schema-v2.md` (create; create the `docs/design/`
  directory)

**Out of scope** (do NOT touch):
- `src/core/inventory.ts` — **especially** `INVENTORY_SCHEMA_VERSION`. Changing
  it is the implementation, not the spike.
- `src/core/diff.ts`, and all five files in `src/browser/` matching
  `*-service.ts`.
- `PLAN.md` and `HANDOFF.md` — they have uncommitted local edits; the design
  document is a new file precisely to avoid that conflict.
- Any encryption work.

## Git workflow

- Branch: `advisor/005-multi-device-schema-spike`
- Commit per deliverable; messages:
  `test: characterize inventory parse and serialize behavior` and
  `docs: specify multi-device inventory schema v2`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterize today's parse/serialize behavior

Create `tests/inventory-characterization.test.ts`. Its purpose is to make the
future migration safe: it pins what v1 does *today* so a v2 lift can be proven
not to break v1 reading.

These tests must describe current behavior, **not** desired behavior. If one
fails, you have found a bug — report it, do not "fix" the test to pass.

Cover, at minimum:

1. **Round trip preserves content.** Build a fixture with **at least five**
   extensions spanning both `browserFamily` values, with names and IDs that sort
   differently from each other. Assert
   `serializeInventory(parseInventoryJson(serializeInventory(doc)))` equals
   `serializeInventory(doc)` byte for byte. (Note: compare *serialized* forms.
   The in-memory array order legitimately differs, because `parseInventoryJson`
   sorts by name-then-id while `serializeInventory` sorts by
   `browserFamily:id` — pin that fact in a comment.)
2. **Canonical serialization order** is `browserFamily:id`, ascending. Assert it
   directly on a fixture whose name order differs from its id order.
3. **Schema-version rejection.** `parseInventoryJson` on a document with
   `schemaVersion: 2` throws `InventoryFormatError` with code
   `unsupported_schema`. **This is the migration constraint** — pin it
   explicitly with a comment saying so.
4. **Missing `schemaVersion` entirely** falls through to `invalid_inventory`.
5. **Invalid JSON** yields `invalid_json`.
6. **Validation gaps that exist today.** `isInventoryDocument` does *not*
   validate `sourceUrl`, `homepageUrl`, or `updateUrl`. Assert that a document
   carrying a non-HTTPS `sourceUrl` currently parses successfully. Add a comment
   marking this as known-permissive and tracked separately — do not tighten it
   here.
7. **Self-exclusion.** `captureInventory` omits the extension whose id matches
   `management.getSelf()`, and omits non-`extension` types. Use a fake
   `ManagementApi` and an injected `now`.

**Verify**: `npx vitest run tests/inventory-characterization.test.ts` → all
pass. Then `npm test` → all pass, no pre-existing test broken.

### Step 2: Investigate and record the concrete data-loss path

Before designing, confirm the problem in the code and write down the exact
sequence. Read all five `src/browser/*-service.ts` files and confirm each
upload writes the full local document and each pull only stores a baseline.

Record, for the design document, the precise interleaving that loses data
(device A uploads → device B pulls → device B uploads → A's records are gone)
with `file:line` citations for each step.

**Verify**: you can cite the upload and pull line ranges for **all five**
services. If any service *does* merge, that changes the finding — STOP and
report.

### Step 3: Write the design document

Create `docs/design/inventory-schema-v2.md`. It must be readable by someone who
has not seen this plan. Required sections:

1. **Problem** — the data-loss interleaving from Step 2, with citations. State
   plainly that today's remote file is whichever device wrote last.
2. **Proposed v2 document** — a concrete, complete JSON example following
   `PLAN.md`'s specified shape (`devices` map, per-extension `aliases`,
   `sources`, `stateByDevice`, and tombstones). Give the TypeScript interfaces
   alongside it. Where you deviate from `PLAN.md`, say so and justify it.
3. **Identity resolution** — how a Chromium ID and a Firefox ID become one
   logical extension. Follow `PLAN.md`'s four-step ladder. Be explicit that
   name-only matches are never merged automatically, and specify what a
   "user-confirmed alias" means in storage and in UI terms.
4. **Merge algorithm** — how a local observation folds into a remote union.
   Cover: each device updates only its own `stateByDevice` entry; deletions
   become timestamped tombstones; an offline device must not resurrect a removed
   record; pruning is an explicit maintenance action, never automatic. Include
   the conflict case: what happens when the optimistic-concurrency check fails
   mid-merge.
5. **Migration path** — the hard part. `parseInventoryJson` currently *rejects*
   `schemaVersion: 2` outright (pinned by your Step 1 test), so an old client
   meeting a new document errors rather than degrading. Specify: how v1 remotes
   are lifted to v2 (a v1 document becomes a v2 with exactly one entry in
   `devices` and one `stateByDevice` entry per extension); whether v1 clients
   must be locked out or can be made forward-compatible; and what the user sees
   during the transition. Name which files change.
6. **Encryption sequencing** — a recommendation with reasons. Cover both points
   from "Why this matters": that building the envelope first forces a
   decrypt-lift-re-encrypt migration on remotes users already hold, and that a
   per-write nonce makes every Git commit an opaque binary diff. Give an
   explicit recommendation on `PLAN.md`'s open "encrypted opt-in or default"
   question, and state the trade-off honestly rather than only advocating.
7. **Open questions** — everything you could not resolve from the repository,
   each phrased as a decision the maintainer must make, with your recommended
   answer and a one-line rationale.
8. **Estimated blast radius** — list the files the implementation would touch,
   with a rough size per file.

Be concrete. A design document that says "merge the inventories" is not a
deliverable; one that specifies the tombstone record shape and what happens when
two devices delete the same extension is.

**Verify**: the file exists, contains all eight sections, and every code path it
cites resolves to a real `file:line` (spot-check at least five citations by
opening them).

### Step 4: Full verification

```bash
npm test && npm run typecheck
```

**Verify**: both exit 0.

### Step 5: Confirm scope

**Verify**: `git status --porcelain` → exactly two new entries:
`tests/inventory-characterization.test.ts` and
`docs/design/inventory-schema-v2.md`. **No file under `src/` may appear.**

## Test plan

New file: `tests/inventory-characterization.test.ts`, covering the seven cases
in Step 1. Model its structure on `tests/inventory.test.ts` (fixture-building
style, fake `ManagementApi`, injected `now`).

The distinguishing property of these tests: they assert **current** behavior,
including behavior that is arguably wrong (the permissive URL fields, the
sort-order divergence). Each such case carries a comment saying it is pinned
deliberately, so a future reader does not "correct" it and silently change the
wire format.

Verification: `npm test` → all pass, including the new file, with no
pre-existing test modified.

## Done criteria

ALL must hold:

- [ ] `tests/inventory-characterization.test.ts` exists and covers all seven
      cases from Step 1
- [ ] `npm test` exits 0; no pre-existing test file was modified
      (`git status` shows `tests/` has only the one new file)
- [ ] `npm run typecheck` exits 0
- [ ] `docs/design/inventory-schema-v2.md` exists with all eight sections
- [ ] The design document contains a concrete v2 JSON example and TypeScript
      interfaces, not prose descriptions of them
- [ ] The document gives an explicit recommendation on encryption sequencing
      and on the opt-in-vs-default question
- [ ] `git diff --stat src/` is **empty** — no source file changed
- [ ] `git status --porcelain` shows only the two new files

## STOP conditions

Stop and report back (do not improvise) if:

- Any characterization test in Step 1 fails. That means current behavior differs
  from what this plan describes — report the difference; do not adjust the test
  to make it pass.
- Any of the five service files *does* merge inventories rather than
  overwriting. The premise would be wrong and the design must be reconsidered.
- `INVENTORY_SCHEMA_VERSION` is not `1`, or `parseInventoryJson` does not reject
  version 2.
- You conclude the design requires changing source files to validate. It does
  not — if you cannot specify it without implementing it, say so and report what
  is blocking.
- You are tempted to implement the migration because the design "is obvious".
  It is a one-way door affecting data users already hold. Stop.

## Maintenance notes

- The characterization tests are the safety net for the eventual v2 work. They
  should keep passing through the migration for the v1 *reading* path — that is
  how the lift is proven non-breaking.
- The sort-order divergence pinned in test 1 (`parse` sorts by name, `serialize`
  by `browserFamily:id`) is untidy but harmless today, because `serializeInventory`
  re-canonicalizes on every write and `diffInventories` is Map-keyed. Do not
  "fix" it as a drive-by; if v2 changes canonical ordering, change it there,
  deliberately.
- The permissive URL fields pinned in test 6 are a real security finding tracked
  separately. Tightening them is a deliberate behavior change that will make
  that characterization test fail — which is correct, and the test should then
  be updated in the same commit as the fix.
- A reviewer should read the design document's migration section hardest. The
  rest is design opinion; the migration is the part that can lose user data.
- The implementation this document specifies should get its own plan, written
  only after a human has approved the design.
