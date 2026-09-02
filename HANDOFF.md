# hsync handoff

Last updated: 2026-09-02 (Asia/Riyadh)

## Objective

A FOSS extension-inventory synchronizer for Chromium-family browsers (including
Helium) and Firefox. It records installed extensions, compares inventories, and
syncs them to user-controlled storage. Storage transports are Gitea, GitHub,
WebDAV, and S3-compatible object storage — **all browser-only**.

The UI and architecture intentionally adapt patterns from Bookmarkora. hsync
never reads or copies browser profile files.

Repository: <https://github.com/t1nk333r/hsync> (public, AGPL-3.0-or-later)

## Current state

- Branch `main`, pushed, tree clean apart from untracked `plans/` and this file.
- 187 tests pass; `npm run typecheck`, `npm run build`, `npm run build:firefox`
  all clean.

### The native companion is gone

An optional Go companion (`hsyncd`) for arbitrary Git over SSH/HTTPS was built
across five commits and then **deleted on 2026-08-31** — roughly a third of the
codebase. It required a separate per-OS install, shipped no working installer,
and existed to sync a single sub-768 KB JSON document that four browser-only
backends already handle. See `HELIUM_SYNC_GIT_ADAPTATION.md`.

**Do not reintroduce it.** There is no `native/` directory, no Native Messaging,
no `npm run test:native`, and no SSH transport. Arbitrary Git remotes are out of
scope; Git support means repository-host APIs (Gitea, GitHub).

### Multi-device inventory (schema v2) — the main recent work

v1 held exactly one device, so a second device's upload silently erased the
first's records. Fixed across seven reviewed slices:

- `src/core/inventory-v2.ts` — v2 types, validator (including referential
  integrity), parser, canonical serializer with deterministic key ordering.
- `src/core/inventory-migration.ts` — `liftV1ToV2`, the one-way v1 → v2 lift.
- `src/core/inventory-projection.ts` — `projectDeviceInventory`, materializing
  one device's view in the v1 shape so `diff.ts` needed no changes.
- `src/core/inventory-merge.ts` — the per-device merge. Writes only the merging
  device's own keys, never deletes a map entry, pure.
- `src/browser/inventory-sync.ts` — fetch → merge → conditional write, with a
  retry that re-reads and redoes the merge, plus `upgradeRemoteToV2`.
- The four services now merge instead of overwriting.
- The options page has an "Upgrade to multi-device" action per connection.

`INVENTORY_SCHEMA_VERSION` is still **1**: `captureInventory` writes v1, and a
v1 remote is never auto-converted. `syncV2` refuses a v1 remote and tells the
user to run the upgrade action. This is deliberate (no force-migration), and it
means a user on a v1 remote must upgrade before uploads work.

Design doc: `docs/design/inventory-schema-v2.md`. It is the authority for the
merge algorithm (§4), identity resolution (§3), migration (§5), and encryption
sequencing (§6).

## Architecture map

- Inventory schema/capture (v1): `src/core/inventory.ts`
- Schema v2: `src/core/inventory-v2.ts`, `-migration.ts`, `-projection.ts`, `-merge.ts`
- Comparison: `src/core/diff.ts`
- Backend contract: `src/backends/contract.ts`
- Backends: `src/backends/{webdav,s3,gitea,github}.ts`, `sigv4.ts`
- Sync orchestration: `src/browser/inventory-sync.ts`
- Services/storage: `src/browser/`
- Message router: `entrypoints/background.ts`
- Control center (full tab, not a popup): `entrypoints/options/main.tsx`
- Build config: `wxt.config.ts`

## Security invariants

- Never read or copy browser profile databases or extension data directories.
- Never claim silent installation of arbitrary browser extensions.
- Never put tokens in URLs, logs, or extension storage beyond their own config.
- Credentialed requests set `redirect: 'error'` — a 30x must never replay an
  Authorization header or SigV4 signature to another host.
- Repository paths reject `..`, `.`, `.git`, and empty segments; branch names
  are restricted and may not begin with `-`.
- Inventory source URLs are http/https only — they are rendered as anchors in a
  page holding the `management` permission.
- Conflicting writes fail and are resolved by re-reading and re-merging, never
  by last-write-wins.
- The per-sync merge only adds or tombstones; it never deletes a map entry.

## Verification

```bash
npm ci          # never `npm install` — a partial install breaks every build
npm test
npm run typecheck
npm run build
npm run build:firefox
```

Outputs: `.output/chrome-mv3/`, `.output/firefox-mv3/`.

## What is actually left

**Nobody has run this in a browser.** The options page has no test harness, so
the upgrade buttons, the confirm dialog, and the toolbar-icon-opens-a-tab
behavior are verified by reading only. This is the largest untested surface and
deserves its own slice.

Open, roughly by leverage:

- Cross-browser identity resolution (§3). `diff.ts` keys on
  `browserFamily:id`, so a Firefox add-on can never match its Chromium
  counterpart. `tests/inventory-projection.test.ts` pins that limitation.
- Pruning of stale devices and fully-uninstalled records (§4), user-confirmed.
- Encryption (§6) — opt-in, AES-256-GCM over the canonical document, wrapping
  every backend uniformly. Do not implement it inside one transport.
- Guided restore and enabled-state reconciliation (Milestone 4). The README no
  longer claims these exist.
- A v1 client pulling an upgraded remote gets `unsupported_schema`; §5 asks for
  friendlier copy telling the user to update hsync on that device.
- Per-backend stored remote version is now written but never read by services.
- Backend de-duplication: the four services are near-identical, now with tests
  making that refactor safe.
- No lint or formatter; no `CLAUDE.md`/`AGENTS.md`; no WebDAV setup guide.
- `alarms` permission declared and unused; `@types/chrome` unused.

## Working notes

- `plans/` (untracked) holds the audit trail and 14 executor plans, including
  several unfixed-finding write-ups. It was deliberately kept out of the public
  repo; commit it once those are closed.
- Executor worktrees land on a stale base by default — always branch explicitly
  from current `main` and verify before running a stacked plan.
