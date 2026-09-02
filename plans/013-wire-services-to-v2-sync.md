# Plan 013: Wire the four backend services to the v2 sync path so uploads stop overwriting other devices

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise. Do
> not update `plans/README.md` unless your dispatcher tells you to.
>
> **Base check (run FIRST)**:
> `test -f src/browser/inventory-sync.ts && grep -n "export async function syncV2" src/browser/inventory-sync.ts`
> Must succeed. This plan builds on plan 012; your branch must descend from the
> commit that merged it. Worktrees here are sometimes provisioned at a stale
> commit — check `git rev-parse HEAD`, re-branch if needed, and report what HEAD
> was.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED-HIGH — this is the plan where user-visible sync behavior actually changes
- **Depends on**: `plans/012-inventory-sync-orchestration.md`
- **Category**: bug
- **Planned at**: commit `16f432b`, 2026-09-01

## Why this matters

Plans 011 and 012 built and tested the safe path, but nothing calls it. Every
real upload still runs the old code that writes this device's whole document over
the remote. This plan connects the four services to `syncV2`, which is the point
at which the multi-device data-loss bug is actually fixed for users.

There are exactly **four** services — WebDAV, S3, Gitea, GitHub. (Earlier design
notes mention a fifth, `native-service.ts`; it was deleted with the native
companion and does not exist.)

The key design choice that keeps this plan small: services keep returning a **v1
`InventoryDocument`** to their callers, produced by `projectDeviceInventory`
(`src/core/inventory-projection.ts`). The options page and the message router
therefore need no changes at all, and the visible UI is unchanged. That is why
plan 010 exists.

## Current state

### The service shape you are changing (`src/browser/webdav-service.ts:33-68`)

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

export async function uploadWebDavInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before uploading.');

  const [knownVersion, baseline] = await Promise.all([
    loadWebDavRemoteVersion(),
    loadComparisonBaseline(),
  ]);
  if (baseline && !knownVersion) {
    throw new BackendError(
      'conflict',
      'Pull the WebDAV inventory before replacing an imported comparison baseline.',
    );
  }
  const result = await backend.write({
    data: encoder.encode(serializeInventory(inventory)),
    expectedVersion: knownVersion,
  });
  await saveWebDavRemoteVersion(result.version);
  return inventory;
}
```

`s3-service.ts`, `gitea-service.ts`, and `github-service.ts` have the same two
functions with the same structure, differing only in the backend class, the
per-backend config/version store module, and the wording of their error
messages. **Preserve each file's existing error-message wording** — the options
page surfaces those strings directly to users.

### What the callers expect

`entrypoints/background.ts:143-158` routes `webdav:pull` / `webdav:upload` (and
the same for the other three) and wraps the returned value as
`{ ok: true, inventory }`, typed `InventoryDocument | null` in
`src/browser/messages.ts:45`. The options page consumes that v1 shape directly —
e.g. `baseline?.extensions.length` and `baseline.device.label` at
`entrypoints/options/main.tsx:404`. **Keep returning a v1 `InventoryDocument`**
and none of that has to change.

### The functions you compose

- `syncV2`, `readRemoteDocument` (`src/browser/inventory-sync.ts`, plan 012).
- `projectDeviceInventory(document, deviceId)`
  (`src/core/inventory-projection.ts`) — materializes one device's view in the v1
  shape. It **throws** `InventoryFormatError('invalid_inventory')` for a device
  id absent from the document.
- `getDeviceObservation()` (`src/browser/device.ts:18-42`) — the device id/label
  this browser profile syncs under.
- `loadInventory()` (`src/browser/inventory-store.ts:11-15`) — the latest local
  capture.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install`) |
| Typecheck | `npm run typecheck` | exit 0 |
| All tests | `npm test` | exit 0 |
| Build both | `npm run build` and `npm run build:firefox` | exit 0 |

## Scope

**In scope**:

- `src/browser/webdav-service.ts`
- `src/browser/s3-service.ts`
- `src/browser/gitea-service.ts`
- `src/browser/github-service.ts`
- `tests/webdav.test.ts`, `tests/s3.test.ts`, `tests/gitea.test.ts`,
  `tests/github.test.ts` — extend with the new coverage; **do not delete
  existing cases** unless a case asserts the old overwrite behavior, in which
  case rewrite it and say so in your report.

**Out of scope** — do NOT touch:

- `entrypoints/background.ts`, `entrypoints/options/main.tsx`,
  `src/browser/messages.ts` — the whole point is that the wire format is
  unchanged. If you think one needs editing, that is a STOP condition.
- Every `src/core/*` module and `src/backends/*`.
- The upgrade **UI action** — that is plan 014. This plan exposes the service
  function it will call, nothing more.
- `src/browser/inventory-store.ts` — see the `comparisonBaseline` note below.
- `tsconfig.json`.

## Git workflow

- Branch: `advisor/013-wire-services-to-v2-sync`, from the merge of 012.
- Commit per service if you like, or one commit; conventional style, e.g.
  `feat: sync WebDAV through the v2 merge path`.
- Do NOT push or open a PR.

## Steps

### Step 1: Convert `webdav-service.ts` first, as the template

Rewrite the two functions. `configuredBackend`, `configureAndTestWebDav`, and all
imports of the WebDAV config store stay as they are.

**Pull** becomes: read the remote via `readRemoteDocument(backend)`.

- `kind: 'absent'` → throw the file's existing `not_found` error, wording
  unchanged.
- `kind: 'v1'` → keep today's behavior exactly: save it as the comparison
  baseline, save the version, return it. A v1 remote is still legitimate until
  the user upgrades, and this is what keeps single-device users working.
- `kind: 'v2'` → save the version, and return
  `projectDeviceInventory(document, device.id)` where `device` comes from
  `getDeviceObservation()`. **If this device has no record in the document yet**
  — a first pull on a new device — `projectDeviceInventory` throws. Guard that
  case: when `document.devices[device.id]` is absent, return a valid empty
  projection instead (an `InventoryDocument` with `schemaVersion: 1`,
  `generatedAt` = the document's `updatedAt`, this device's observation, and
  `extensions: []`). Do not let the throw reach the user; a device that has
  never synced is normal, not corrupt.
- Persist the v2 document as the comparison baseline **projected**, so the
  options page's Compare view keeps working against the v1-shaped value it
  already understands.

**Upload** becomes: load the local capture (keeping the existing
`'Scan local extensions before uploading.'` error when absent), then call
`syncV2({ backend, local })`, save the returned `version`, and return
`projectDeviceInventory(result.document, device.id)`.

Delete the `baseline && !knownVersion` pre-check: it exists to stop a
whole-document overwrite from destroying an imported baseline, and `syncV2`
merges rather than overwrites, so the hazard is gone. Say so in your report.

If `syncV2` throws the `conflict` error meaning "this remote is still v1"
(plan 012 step 2), let it propagate unchanged — its message already tells the
user to run the upgrade action.

Also export, for plan 014 to call later:

```ts
export async function upgradeWebDavInventory(): Promise<InventoryDocument>
```

which calls `upgradeRemoteToV2(backend)`, saves the returned version, and returns
the projection for this device (with the same empty-projection guard).

**Verify**: `npm run typecheck` → exit 0; `npm test -- tests/webdav.test.ts` → exit 0.

### Step 2: Apply the same conversion to the other three services

`s3-service.ts`, `gitea-service.ts`, `github-service.ts` — same structure, each
keeping its own backend class, its own config/version store imports, and **its
own existing error-message wording**. Add `upgradeS3Inventory`,
`upgradeGiteaInventory`, `upgradeGitHubInventory` correspondingly.

Resist extracting a shared helper across the four files in this plan even though
the duplication is obvious. The four differ in store module and message wording,
the change is already the riskiest in the sequence, and a de-duplication refactor
belongs in its own reviewable slice.

**Verify**: `npm run typecheck` → exit 0; `npm test` → exit 0.

### Step 3: Extend the four backend test files

See "Test plan".

**Verify**: `npm test` → exit 0.

### Step 4: Full verification

- `npm test`, `npm run typecheck`, `npm run build`, `npm run build:firefox` → all exit 0.
- `git diff --stat <base>..HEAD -- src/core/ entrypoints/ src/backends/ src/browser/messages.ts` → **empty**.
- `grep -rn "serializeInventory(" src/browser/*-service.ts` → no matches (the v1
  whole-document write is gone from every service).

## Test plan

Extend each of `tests/webdav.test.ts`, `tests/s3.test.ts`,
`tests/gitea.test.ts`, `tests/github.test.ts`. Read one first for the house
fake-transport style and reuse it.

Per service, at minimum:

1. **Pull from a v2 remote** returns this device's projection, with the right
   extensions and `device.id`.
2. **Pull from a v2 remote with no record for this device** returns an empty
   projection and does **not** throw.
3. **Pull from a v1 remote** still returns the v1 document unchanged
   (single-device users keep working).
4. **Upload merges instead of overwriting** — the load-bearing case. Seed the
   fake remote with a v2 document containing a *peer* device's state, upload from
   this device, and assert the bytes written still contain the peer's
   `stateByDevice` entry. Under the old code this test fails.
5. **Upload against a v1 remote** surfaces the `conflict` error telling the user
   to upgrade, and writes nothing.
6. **The upgrade function** lifts a v1 remote and writes it with the version from
   its own read.

At least one service (WebDAV is fine) should additionally cover: upload against
an absent remote creates the document, and a conflicting write is retried and
still preserves the peer's state end-to-end through the service layer.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; all four backend test files carry the new cases
- [ ] `npm run build` and `npm run build:firefox` both exit 0
- [ ] `grep -rn "serializeInventory(" src/browser/*-service.ts` returns no matches
- [ ] `git diff <base>..HEAD -- entrypoints/ src/core/ src/backends/ src/browser/messages.ts` produces empty output
- [ ] Each service exports its `upgrade*Inventory` function
- [ ] `grep -c "as any" src/browser/*-service.ts` returns 0 for each

## STOP conditions

Stop and report back if:

- `src/browser/inventory-sync.ts` is missing or `syncV2`'s signature differs from
  plan 012's — wrong base, or the two plans disagree.
- You conclude `entrypoints/background.ts`, `src/browser/messages.ts`, or
  `entrypoints/options/main.tsx` must change. Returning a projected v1
  `InventoryDocument` is specifically designed to make that unnecessary; if
  something forces it, a human should decide.
- An existing backend test fails in a way that looks like it was asserting the
  old overwrite behavior. Report which test and what it asserted — do not
  quietly delete it.
- You are tempted to extract a shared service helper across the four files.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

- After this lands, **uploads merge and the multi-device data-loss bug is fixed
  for any backend whose remote has been upgraded to v2.** A v1 remote is still
  overwrite-free only because upload refuses to run against it — the user must
  invoke the upgrade action (plan 014) to actually get the protection.
- `comparisonBaseline` is now storing a *projection* of the union rather than an
  independently pulled document. That is a deliberate stopgap: the design doc
  (§5, "Files that change") expects the baseline concept to be retired or
  repurposed as a cache once the UI reads the union directly. Left alone here to
  keep this plan's blast radius small.
- The four services are now near-identical. De-duplicating them is a real
  follow-up, and a much safer one once these tests exist.
- A reviewer should read case 4 in each test file first: it is the direct
  regression test for the bug this whole sequence exists to fix.
