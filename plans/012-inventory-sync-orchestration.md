# Plan 012: Add backend-agnostic sync orchestration — fetch, merge, conditional write, and safe conflict retry

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise. Do
> not update `plans/README.md` unless your dispatcher tells you to.
>
> **Base check (run FIRST)**:
> `test -f src/core/inventory-merge.ts && test -f src/core/inventory-migration.ts && test -f src/core/inventory-v2.ts`
> All three must exist. This plan builds on plan 011; your branch must descend
> from the commit that merged it. Worktrees here are sometimes provisioned at a
> stale commit — check `git rev-parse HEAD` and re-branch if needed, reporting
> what HEAD was.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED — new code path that performs real conditional writes
- **Depends on**: `plans/011-inventory-v2-merge.md`
- **Category**: bug
- **Planned at**: commit `16f432b`, 2026-09-01

## Why this matters

Plan 011 wrote the merge. This plan gives it a body: the fetch → merge →
conditional-write cycle, the retry that makes a concurrent write safe instead of
destructive, and the one-way upgrade that lifts an existing v1 remote to v2.

It is written **backend-agnostic** — against the `InventoryBackend` interface,
not against WebDAV or S3 — for two reasons. It can be tested against a fake
backend with no network, and the four service files can each be wired to it in
plan 013 without four copies of the same subtle retry logic. The four services
today duplicate this logic already, which is a standing finding.

## Current state

### The backend contract you build on (`src/backends/contract.ts:1-40`)

```ts
export interface BackendReadResult { data: Uint8Array; version: string }
export interface BackendWriteInput { data: Uint8Array; expectedVersion: string | null }
export interface BackendWriteResult { version: string }

export interface InventoryBackend {
  read(): Promise<BackendReadResult | null>;
  write(input: BackendWriteInput): Promise<BackendWriteResult>;
  testConnection(): Promise<void>;
}

export type BackendErrorCode =
  | 'authentication' | 'conflict' | 'forbidden' | 'invalid_config'
  | 'missing_version' | 'network' | 'not_found' | 'server';

export class BackendError extends Error {
  constructor(
    public readonly code: BackendErrorCode,
    message: string,
    public readonly status?: number,
  ) { super(message); this.name = 'BackendError'; }
}
```

`read()` returns `null` when the remote document does not exist yet. A write
whose `expectedVersion` no longer matches surfaces as
`BackendError('conflict', …)`.

### The v1 code path this will eventually replace (`src/browser/webdav-service.ts:33-68`)

```ts
export async function pullWebDavInventory() {
  const backend = await configuredBackend();
  const remote = await backend.read();
  if (!remote) throw new BackendError('not_found', 'No hsync inventory exists at this WebDAV location yet.');
  const inventory = parseInventoryJson(decoder.decode(remote.data));
  await Promise.all([ saveComparisonBaseline(inventory), saveWebDavRemoteVersion(remote.version) ]);
  return inventory;
}

export async function uploadWebDavInventory() {
  const backend = await configuredBackend();
  const inventory = await loadInventory();
  if (!inventory) throw new BackendError('not_found', 'Scan local extensions before uploading.');
  const [knownVersion, baseline] = await Promise.all([ loadWebDavRemoteVersion(), loadComparisonBaseline() ]);
  if (baseline && !knownVersion) {
    throw new BackendError('conflict', 'Pull the WebDAV inventory before replacing an imported comparison baseline.');
  }
  const result = await backend.write({
    data: encoder.encode(serializeInventory(inventory)),
    expectedVersion: knownVersion,
  });
  await saveWebDavRemoteVersion(result.version);
  return inventory;
}
```

Note what upload does: it writes **the whole local document**, unconditionally
replacing whatever the remote held. That is the data-loss bug. The s3, gitea,
and github services have the same shape. **You are not editing them** — that is
plan 013 — but you must understand what your new path replaces.

### The core functions you compose

- `parseInventoryJson` / `isInventoryDocument` (`src/core/inventory.ts`) — v1.
- `parseInventoryJsonV2` / `serializeInventoryV2` / `isInventoryDocumentV2`
  (`src/core/inventory-v2.ts`).
- `liftV1ToV2` (`src/core/inventory-migration.ts`).
- `mergeLocalObservation` (`src/core/inventory-merge.ts`, from plan 011) — read
  its signature and its maintenance notes before starting.

### The rollout rule you must not break

`docs/design/inventory-schema-v2.md` §5 "Rollout sequencing":

> 1. Ship v2-capable code that still **defaults to writing v1-shaped documents**
>    for any backend whose remote is currently v1 or empty. No existing
>    single-device user is force-migrated by an extension update alone.
> 2. Add an explicit "Upgrade to multi-device inventory" action (options page).
>    On click: pull the current remote, run `liftV1ToV2` if it is still
>    v1-shaped, write the v2 document with `expectedVersion` from the pull (so
>    the same optimistic-concurrency protection applies to the upgrade write
>    itself) …
> 4. No downgrade path is provided.

So: **an ordinary sync must never silently convert a v1 remote to v2.** Upgrading
is a separate, explicitly invoked function. Getting this wrong would migrate
users without consent and strand their other devices, which still run v1-only
clients.

### TypeScript strictness

`tsconfig.json:5-6`: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
No `as any`; `tsconfig.json` is out of scope.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install`) |
| Typecheck | `npm run typecheck` | exit 0 |
| All tests | `npm test` | exit 0 |
| One test file | `npm test -- tests/inventory-sync.test.ts` | exit 0 |
| Build | `npm run build` | exit 0 |

## Scope

**In scope**:

- `src/browser/inventory-sync.ts` (create)
- `tests/inventory-sync.test.ts` (create)

**Out of scope** — do NOT touch:

- `src/browser/webdav-service.ts`, `s3-service.ts`, `gitea-service.ts`,
  `github-service.ts` — wiring them is plan 013. Leaving them untouched is what
  makes this plan safe to land: no user-visible behavior changes.
- `src/browser/inventory-store.ts` — the `comparisonBaseline` question is plan
  013's.
- `src/backends/*` — the contract is an input, not something to change.
- Every `src/core/*` module — all finished.
- `entrypoints/*`, `tsconfig.json`.

**Do not use `browser.storage` in this module.** It must be a pure function of
its arguments plus the injected backend, so it is testable without a browser
environment. Version tokens are passed in and returned, not read from storage.

## Git workflow

- Branch: `advisor/012-inventory-sync-orchestration`, from the merge of 011.
- Conventional commits, e.g. `feat: add backend-agnostic v2 sync orchestration`.
- Do NOT push or open a PR.

## Steps

### Step 1: Create `src/browser/inventory-sync.ts` with the read side

```ts
export type RemoteDocumentShape =
  | { kind: 'absent' }
  | { kind: 'v1'; document: InventoryDocument; version: string }
  | { kind: 'v2'; document: InventoryDocumentV2; version: string };

export async function readRemoteDocument(
  backend: InventoryBackend,
): Promise<RemoteDocumentShape>
```

Behavior: call `backend.read()`. On `null` return `{ kind: 'absent' }`. Otherwise
decode with `new TextDecoder()` and dispatch on shape — try
`parseInventoryJsonV2` first; if it throws `InventoryFormatError` with code
`unsupported_schema`, try `parseInventoryJson` (v1). If **both** reject, rethrow
the v2 error, since v2 is the format this code path expects.

Do not "sniff" the JSON by hand — use the existing parsers so validation stays in
one place.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add the sync cycle with conflict retry

```ts
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

export async function syncV2(input: SyncV2Input): Promise<SyncV2Result>
```

The cycle, per `docs/design/inventory-schema-v2.md` §4:

1. `readRemoteDocument(backend)`.
   - `kind: 'v2'` → merge into it, `expectedVersion` = its `version`.
   - `kind: 'absent'` → merge into an empty document
     (`{ schemaVersion: 2, revision: '0', updatedAt: <timestamp>, devices: {}, extensions: {} }`),
     `expectedVersion` = `null`. Creating a brand-new remote is not a migration,
     so this is allowed.
   - `kind: 'v1'` → **throw** `BackendError('conflict', 'This remote still uses the single-device format. Run "Upgrade to multi-device inventory" before syncing.')`.
     Do NOT auto-upgrade; see the rollout rule above.
2. `mergeLocalObservation({ remote, local, now, newExtensionId })`.
3. `backend.write({ data: encoder.encode(serializeInventoryV2(merged)), expectedVersion })`.
4. On `BackendError` with `code === 'conflict'`: **re-fetch and redo the whole
   cycle from step 1** against the freshly fetched document — never retry
   against the stale one, and never reuse the previously merged result. Up to
   `maxAttempts` total attempts; on exhaustion rethrow the last conflict error.
   Any other error propagates immediately without retrying.
5. Return the merged document, the `version` from the write result, and the
   attempt count.

The design doc explains why redoing the whole merge is safe: every write is
scoped to this device's own keys, so a redo against a newer remote produces the
same semantic result no matter how many times a peer raced ahead.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Add the explicit one-way upgrade

```ts
export interface UpgradeResult {
  document: InventoryDocumentV2;
  version: string;
  /** false when the remote was already v2 and nothing was written. */
  upgraded: boolean;
}

export async function upgradeRemoteToV2(
  backend: InventoryBackend,
  options?: { newExtensionId?: () => string },
): Promise<UpgradeResult>
```

Behavior:

- `kind: 'v2'` → return `{ document, version, upgraded: false }` **without
  writing**. Upgrading an already-upgraded remote must be a no-op, because the
  UI action will be clickable more than once.
- `kind: 'v1'` → `liftV1ToV2(document, options)`, then write with
  `expectedVersion` set to the version from that same read. This is the
  design's explicit requirement: the upgrade write is protected by the same
  optimistic-concurrency check as any other write, so a concurrent change is not
  silently overwritten during the migration itself.
- `kind: 'absent'` → throw `BackendError('not_found', 'There is no inventory at this location to upgrade.')`.
- A conflict here is **not** retried — rethrow it. A racing write during an
  upgrade deserves the user's attention, not an automatic redo.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Write `tests/inventory-sync.test.ts`

See "Test plan".

**Verify**: `npm test -- tests/inventory-sync.test.ts` → exit 0.

### Step 5: Full verification

- `npm test` → exit 0, all pre-existing tests still pass.
- `npm run typecheck`, `npm run build` → exit 0.
- `git diff --stat <base>..HEAD -- src/core/ src/backends/ entrypoints/` → empty.
- `grep -c "browser\.storage" src/browser/inventory-sync.ts` → `0`.

## Test plan

Create `tests/inventory-sync.test.ts`. The existing backend tests
(`tests/webdav.test.ts`, `tests/gitea.test.ts`) show the house style for
fake-transport tests — read one first.

Write a **fake `InventoryBackend`** at module scope: an object holding an
in-memory `{ data, version } | null`, a monotonically increasing version counter,
a call log, and a `write` that throws `BackendError('conflict', …)` when
`expectedVersion` does not match the stored version. Give it a hook to inject a
concurrent write between a read and the next write, so the retry path can be
driven deterministically.

Required cases:

1. **Absent remote**: `syncV2` against an empty backend writes a valid v2
   document containing exactly this device, with `expectedVersion: null`.
2. **v2 remote**: merges into it and writes with the fetched version as
   `expectedVersion`. Assert the exact `expectedVersion` passed to `write`.
3. **v1 remote is refused**: `syncV2` throws `BackendError` with
   `code === 'conflict'` and **performs no write** (assert the fake's write was
   never called). This is the no-force-migration rule.
4. **Conflict retry succeeds**: arrange for the first write to conflict because a
   peer wrote in between; assert the second attempt succeeds, `attempts === 2`,
   and — critically — that the peer's device state is **still present** in the
   final document. This is the test that proves the retry merges rather than
   clobbers.
5. **Retry re-reads**: assert the fake's `read` was called once per attempt, and
   that the second merge ran against the peer's newer document (not the stale
   one).
6. **Retry exhaustion**: a backend that always conflicts throws after exactly
   `maxAttempts` attempts, with the conflict error.
7. **Non-conflict errors are not retried**: a backend whose `write` throws
   `BackendError('authentication', …)` propagates immediately with exactly one
   write attempt.
8. **Round trip**: the bytes written parse back via `parseInventoryJsonV2` and
   satisfy `isInventoryDocumentV2`.
9. **`upgradeRemoteToV2` on a v1 remote**: writes the lifted document with
   `expectedVersion` equal to the version read, returns `upgraded: true`, and
   the written bytes parse as v2 with one device.
10. **`upgradeRemoteToV2` is idempotent**: against a v2 remote it returns
    `upgraded: false` and performs **no write**.
11. **`upgradeRemoteToV2` on an absent remote** throws `BackendError` with
    `code === 'not_found'`.
12. **Upgrade conflicts are not retried**: a backend that conflicts on the
    upgrade write throws after exactly one write attempt.
13. **`readRemoteDocument`** returns the right `kind` for: absent, a v1 document,
    a v2 document, and throws `InventoryFormatError` for malformed JSON.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, all pre-existing tests still passing
- [ ] `npm test -- tests/inventory-sync.test.ts` exits 0 covering all 13 cases
- [ ] `npm run build` exits 0
- [ ] `git status --short` lists exactly the two new files
- [ ] `grep -c "browser\.storage" src/browser/inventory-sync.ts` returns 0
- [ ] `grep -c "as any" src/browser/inventory-sync.ts` returns 0
- [ ] No file under `src/core/`, `src/backends/`, or `entrypoints/` is modified

## STOP conditions

Stop and report back if:

- `src/core/inventory-merge.ts` is absent — wrong base.
- `mergeLocalObservation`'s actual signature differs from what plan 011
  specified. Report the difference rather than adapting silently.
- You conclude `syncV2` needs to auto-upgrade a v1 remote to work. It does not,
  and doing so would force-migrate users; report what led you there.
- You need `browser.storage` inside this module to make a test pass — the module
  is meant to be storage-free and the version token is a parameter.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

- **Nothing calls this when it lands.** Plan 013 wires the four services to it.
- The retry's soundness rests entirely on `mergeLocalObservation` writing only
  this device's own keys. If that ever changes, this retry silently becomes a
  clobber. Keep the two plans' maintenance notes in sync.
- Deliberately deferred: pruning, alias confirmation, encryption, and any
  scheduled/automatic sync. Also deferred: deciding what happens to
  `comparisonBaseline` (plan 013).
- A reviewer should scrutinize case 4 hardest — it is the one that proves a
  concurrent write survives — and case 3, which proves we do not migrate anyone
  without an explicit action.
