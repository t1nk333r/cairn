# Plan 014: Add the "Upgrade to multi-device inventory" action so users can actually turn the fix on

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise. Do
> not update `plans/README.md` unless your dispatcher tells you to.
>
> **Base check (run FIRST)**:
> `grep -n "export async function upgradeWebDavInventory" src/browser/webdav-service.ts`
> Must succeed. This plan builds on plan 013; your branch must descend from the
> commit that merged it. Worktrees here are sometimes provisioned at a stale
> commit — check `git rev-parse HEAD`, re-branch if needed, and report what HEAD
> was.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED — small surface, but it triggers a one-way, irreversible migration
- **Depends on**: `plans/013-wire-services-to-v2-sync.md`
- **Category**: migration
- **Planned at**: commit `16f432b`, 2026-09-01

## Why this matters

After plan 013, uploads merge safely — but only against a remote that is already
in the v2 multi-device format, and nothing in the product can put it there.
Existing users are left with an upload that refuses to run and an error telling
them to click a button that does not exist. This plan adds that button, its
message-router branches, and the copy that explains what it does.

It is deliberately the last plan in the sequence, because it is the moment a
user's remote data changes shape irreversibly.

## Current state

### The service functions to call (added by plan 013)

`upgradeWebDavInventory()`, `upgradeS3Inventory()`, `upgradeGiteaInventory()`,
`upgradeGitHubInventory()` — each pulls, lifts a v1 document to v2, writes it
back with the `expectedVersion` from its own read, and returns this device's
projected `InventoryDocument`. Read one before starting.

### The message contract (`src/browser/messages.ts:7-51`)

```ts
export type HsyncRequest =
  | { type: 'inventory:capture' }
  | { type: 'inventory:get' }
  …
  | { type: 'webdav:pull' }
  | { type: 'webdav:upload' }
  …

export type HsyncResponse =
  | { ok: true; inventory: InventoryDocument | null }
  | { ok: true; webdavConfig: StoredWebDavConfig | null }
  …
  | { ok: true }
  | { ok: false; error: string };
```

Your four new request types return `{ ok: true; inventory }`, which the response
union already covers — **no change to `HsyncResponse` is needed.**

### The router pattern to match (`entrypoints/background.ts:143-158`)

```ts
      if (request.type === 'webdav:pull') {
        return pullWebDavInventory()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
```

Copy this shape exactly for each new branch. The router is a flat sequence of
`if (request.type === …)` blocks; add yours next to the matching backend's
existing pull/upload pair.

### The options page

`entrypoints/options/main.tsx` sends requests through its `sendRequest` helper
and renders per-backend connection panels. Read the WebDAV panel and its Pull /
Upload buttons, and match their markup, class names, and error/status handling
exactly. The nav sections live in the `NAV_SECTIONS` array at module scope —
**do not add a nav entry**; this control belongs inside each existing connection
panel.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 (use `ci`, never `install`) |
| Typecheck | `npm run typecheck` | exit 0 |
| All tests | `npm test` | exit 0 |
| Build both | `npm run build` and `npm run build:firefox` | exit 0 |

## Scope

**In scope**:

- `src/browser/messages.ts` — four new request types only
- `entrypoints/background.ts` — four new router branches only
- `entrypoints/options/main.tsx` — the upgrade control in each of the four
  connection panels

**Out of scope** — do NOT touch:

- Every `src/core/*` module, `src/browser/inventory-sync.ts`, the four
  `*-service.ts` files, `src/backends/*` — all finished in earlier plans.
- `wxt.config.ts`, the manifest, permissions.
- Any nav/section restructuring in `main.tsx`. Three nav anchors in this file
  (`#restore`, `#automation`, `#safety`) already point at sections that do not
  exist; that is a known separate finding. **Do not fix it here** and do not add
  a fourth.
- `tsconfig.json`.

## Git workflow

- Branch: `advisor/014-upgrade-to-multi-device-action`, from the merge of 013.
- Conventional commits, e.g. `feat: add the multi-device upgrade action`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add the four request types

In `src/browser/messages.ts`, add to `HsyncRequest`:

```ts
  | { type: 'webdav:upgrade' }
  | { type: 's3:upgrade' }
  | { type: 'gitea:upgrade' }
  | { type: 'github:upgrade' }
```

Place each next to its backend's existing `pull`/`upload` entries. `HsyncResponse`
needs no change.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Add the four router branches

In `entrypoints/background.ts`, import the four `upgrade*Inventory` functions
alongside the existing per-service imports, and add one branch per backend
following the excerpt above verbatim in shape.

**Verify**: `npm run typecheck` → exit 0, and
`grep -c "request.type === '" entrypoints/background.ts` returns 25 (21 today
plus your 4).

### Step 3: Add the control to each connection panel

In each of the four connection panels in `entrypoints/options/main.tsx`, add an
**Upgrade to multi-device inventory** button beside the existing Pull/Upload
controls, wired to the matching `*:upgrade` request through the same
`sendRequest` helper and the same status/error handling those buttons already
use. Match the surrounding markup and class names — do not introduce a new
visual style.

Two behaviors the control must have:

1. **Confirm before running.** This is a one-way door: the design doc (§5) states
   "No downgrade path is provided… once a given backend's remote is upgraded, it
   stays v2," and other devices still running older builds of hsync will stop
   being able to read that remote until they update. Use a `window.confirm` with
   copy that says, in plain language, that the remote will be converted to the
   multi-device format, that it cannot be converted back, and that other devices
   need an up-to-date hsync to keep syncing. Do not run the upgrade if the user
   cancels.
2. **Report the outcome distinctly.** The service returns after a no-op when the
   remote is already v2. Surface that as its own message (e.g. "This inventory is
   already in the multi-device format.") rather than a success that implies
   something changed. If plan 013's service function does not distinguish the
   two, report that as a STOP rather than guessing — you may need its
   `upgraded: boolean` surfaced.

Add one short sentence of static help text near the control explaining what
multi-device format means: each device records its own state, so two browsers can
sync to the same remote without overwriting each other.

**Verify**: `npm run typecheck` → exit 0; `npm run build` and
`npm run build:firefox` → exit 0.

### Step 4: Full verification

- `npm test` → exit 0, all pre-existing tests still pass.
- `npm run typecheck`, `npm run build`, `npm run build:firefox` → exit 0.
- `git diff --stat <base>..HEAD -- src/core/ src/backends/ src/browser/` shows
  **only** `src/browser/messages.ts`.
- `grep -c "upgrade" src/browser/messages.ts` returns 4.

## Test plan

The options page has no test harness in this repository and this plan does not
add one — that is a real gap, recorded below, not something to solve here.

What you must verify instead, and report explicitly:

1. `npm test` still passes in full (the service-layer upgrade behavior is already
   covered by plan 013's tests).
2. Both production builds succeed.
3. A manual reading check, reported in your own words: for each of the four
   panels, name the file and line of the button you added and the request type it
   sends, and confirm each sends its **own** backend's type. A copy-paste error
   that points the S3 button at `webdav:upgrade` would migrate the wrong remote,
   and no test in this repository would catch it. Check all four deliberately.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0
- [ ] `npm run build` and `npm run build:firefox` both exit 0
- [ ] `grep -c "request.type === '" entrypoints/background.ts` returns 25
- [ ] All four `*:upgrade` types exist in `src/browser/messages.ts` and each is
      handled in `entrypoints/background.ts`
- [ ] Each of the four panels has an upgrade control wired to its own backend's
      request type, confirmed one by one and reported
- [ ] The confirmation prompt is present and cancelling it performs no request
- [ ] `git diff <base>..HEAD -- src/core/ src/backends/` produces empty output
- [ ] No new nav entry was added to `NAV_SECTIONS`

## STOP conditions

Stop and report back if:

- The `upgrade*Inventory` functions do not exist — wrong base.
- The service function does not let you distinguish "upgraded" from "already
  v2"; say so rather than reporting both as plain success.
- You conclude the control needs its own nav section or a restructure of
  `main.tsx`'s layout.
- Adding the branches requires changing `HsyncResponse` — it should not, and if
  it does, something upstream differs from what this plan describes.
- Two consecutive fix attempts fail to make a verification command pass.

## Maintenance notes

- **This completes the multi-device sequence (008 → 014).** After it lands, a
  user can upgrade a remote and two devices can sync to it without losing each
  other's data — the Milestone 2 exit condition in `PLAN.md:229-238`.
- Still deliberately absent afterwards, and worth stating plainly to whoever
  plans next: cross-browser identity resolution and the alias-confirmation UI
  (`docs/design/inventory-schema-v2.md` §3), pruning (§4), and encryption (§6).
  Compare still cannot match a Firefox add-on to its Chromium counterpart.
- A v1 client pulling an upgraded remote gets
  `InventoryFormatError('unsupported_schema')`. §5 asks for that to be surfaced
  as "This inventory was upgraded to multi-device format on another device —
  install the latest version of hsync on this device to continue syncing."
  That copy change is **not** in this plan; it belongs to whoever next touches
  the error-rendering path, and it is worth doing soon, because it is what an
  out-of-date second device will see.
- The missing options-page test harness is the largest untested surface in the
  project. It should be its own plan.
