# Plan 004: Coalesce and serialize inventory capture, and stop dropping its errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Base check (run first)**: `git log --oneline -1` must show `1b12c60`. If not,
> you are on the wrong base — STOP. Then
> `git diff --stat 1b12c60..HEAD -- entrypoints/background.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as
> a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/006-remove-native-companion.md
- **Base branch**: `advisor/006-remove-native-companion` (tip `1b12c60`) — NOT `main`
  (plan 003 was REJECTED as disproven, so there is no longer a dependency on it)
- **Category**: bug
- **Planned at**: commit `2f8fe62`, 2026-08-31; **refreshed against `1b12c60` (post-006)**, 2026-08-31

## Why this matters

Four browser `management` events each kick off a full inventory capture with no
coordination:

- **They run concurrently.** A burst of events — a bulk enable/disable, a
  profile restore, an extension auto-update — fires N overlapping captures.
  Each takes its own timestamp and each writes the *whole* inventory document
  to `storage.local`. The write that resolves last wins, and that is not
  necessarily the one holding the newest snapshot. The stored inventory can end
  up describing a state that never existed.
- **They are wasteful.** Each capture enumerates every installed extension,
  normalizes it, and sorts the full set. N events do N full scans where one
  coalesced scan after the burst settles produces the identical result.
- **Their failures vanish.** Each call is `void captureAndSave()` with no
  `.catch`. A storage-quota error or a `management` API failure becomes a
  silent unhandled rejection: the inventory goes stale with no indication
  anywhere, and the next "Upload" pushes the stale document to the remote.

One debounced, serialized `scheduleCapture()` fixes all three.

## Current state

`entrypoints/background.ts:36-43` — the capture function. It is not the problem
and must not change:

```ts
async function captureAndSave() {
  const inventory = await captureInventory({
    management: browser.management,
    device: await getDeviceObservation(),
  });
  await saveInventory(inventory);
  return inventory;
}
```

`entrypoints/background.ts:45-53` — the five callers. The four `management`
ones are the target:

```ts
export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void captureAndSave();
  });

  browser.management.onInstalled.addListener(() => void captureAndSave());
  browser.management.onUninstalled.addListener(() => void captureAndSave());
  browser.management.onEnabled.addListener(() => void captureAndSave());
  browser.management.onDisabled.addListener(() => void captureAndSave());
```

`captureAndSave` is *also* called directly by the `inventory:capture` message
handler (a user pressing "Scan now"). That path must stay immediate and must
keep returning the inventory to the caller — the UI awaits it. Only the four
event-driven calls get debounced.

**Logging convention**: this repository currently has **no logging at all** —
`grep -rn "console\." src/ entrypoints/` returns nothing, and there is no
logging library. The background service worker's console is the only diagnostic
surface available. Use `console.error` for the dropped-rejection fix, and
nothing more elaborate. Do not introduce a logging abstraction.

**MV3 note**: the background script is a service worker and can be terminated
when idle. A pending debounce timer does not survive termination. That is
acceptable here — a missed trailing capture self-corrects on the next event or
the next manual scan — and it is explicitly not this plan's job to solve
(see "Out of scope").

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0, all pass |
| Build (Chrome) | `npm run build` | exit 0 |
| Build (Firefox) | `npm run build:firefox` | exit 0 |

## Scope

**In scope**:
- `entrypoints/background.ts`

**Out of scope** (do NOT touch):
- `src/core/inventory.ts` — `captureInventory` is correct; do not change what a
  capture *produces*, only how often it runs. (The timestamp-churn defect in
  that file is a separate, deliberately unaddressed finding.)
- The `alarms` permission in `wxt.config.ts`. It is declared and unused, and
  wiring a periodic re-capture is a genuine feature with its own design
  questions (interval, backoff, opt-in). Do not add it here.
- The 22 message-handler branches. Only the four `management` listeners change.
- `browser.runtime.onInstalled` at lines 46-48 — a single startup capture with
  no burst risk. Leave it immediate.
- Any attempt to persist the debounce across service-worker termination.

## Git workflow

- Branch: `advisor/004-serialize-inventory-capture`, created **from `advisor/006-remove-native-companion`**
- One commit; message: `fix: coalesce management-event inventory captures`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a coalescing, serializing scheduler

In `entrypoints/background.ts`, directly below `captureAndSave`, add a
module-scope scheduler. It must do three things: coalesce rapid calls onto a
trailing timer, ensure at most one capture is in flight at a time, and never
leak a rejection.

Target shape:

```ts
const CAPTURE_DEBOUNCE_MS = 750;

let captureTimer: ReturnType<typeof setTimeout> | null = null;
let captureInFlight: Promise<unknown> = Promise.resolve();

function scheduleCapture() {
  if (captureTimer !== null) clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    captureTimer = null;
    captureInFlight = captureInFlight
      .then(() => captureAndSave())
      .catch((error: unknown) => {
        console.error('hsync: inventory capture failed', error);
      });
  }, CAPTURE_DEBOUNCE_MS);
}
```

Why this shape:
- `clearTimeout` + reset gives a **trailing** debounce: a burst of ten events
  produces one capture, 750 ms after the last one.
- Chaining onto `captureInFlight` guarantees serialization — a capture that
  starts while another is still writing waits rather than racing it.
- The `.catch` is on the chained promise, so a failure is logged **and** the
  chain stays usable for the next capture. Returning a rejected promise into
  `captureInFlight` would poison every subsequent call.

Keep `CAPTURE_DEBOUNCE_MS` as a named constant.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Route the four management listeners through the scheduler

Replace the four `void captureAndSave()` calls:

```ts
  browser.management.onInstalled.addListener(() => scheduleCapture());
  browser.management.onUninstalled.addListener(() => scheduleCapture());
  browser.management.onEnabled.addListener(() => scheduleCapture());
  browser.management.onDisabled.addListener(() => scheduleCapture());
```

Leave `browser.runtime.onInstalled` and the `inventory:capture` message handler
calling `captureAndSave()` directly.

**Verify**: `grep -c "void captureAndSave()" entrypoints/background.ts` → `1`
(only the `runtime.onInstalled` one remains). Then
`grep -c "scheduleCapture()" entrypoints/background.ts` → `5` (the definition
plus four call sites). Then `npm run typecheck` → exit 0.

### Step 3: Confirm the manual-scan path is untouched

The `inventory:capture` message handler must still call `captureAndSave()`
directly and return its inventory to the caller — debouncing it would make
"Scan now" appear to do nothing for three-quarters of a second and would break
the response contract.

**Verify**: `grep -n "inventory:capture" -A 3 entrypoints/background.ts` → the
branch still calls `captureAndSave()` and `.then((inventory) => ...)`.

### Step 4: Full verification

```bash
npm test && npm run typecheck && npm run build && npm run build:firefox
```

**Verify**: all exit 0, no new test failures.

### Step 5: Confirm scope

**Verify**: `git status --porcelain` → exactly one entry,
`entrypoints/background.ts`.

## Test plan

There is no `browser` test fixture in this repository, so the four listeners
cannot be unit-tested without infrastructure that a separate plan covers. Do
**not** build that fixture here.

Required verification is therefore:
- `npm test` passes with no new failures.
- Both builds succeed.
- A manual check, if you can run a browser: load `.output/chrome-mv3/`, enable
  and disable a couple of extensions in quick succession, and confirm the
  background console shows the work settling rather than a burst. Report the
  result honestly, including if you could not run it.

If you can add a cheap automated guard without new infrastructure, this is
acceptable: extract nothing, but export `CAPTURE_DEBOUNCE_MS` and assert it is
a positive number. Only do this if it requires no restructuring.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with no new failures
- [ ] `npm run build` and `npm run build:firefox` both exit 0
- [ ] `grep -c "void captureAndSave()" entrypoints/background.ts` returns `1`
- [ ] `grep -c "scheduleCapture()" entrypoints/background.ts` returns `5`
- [ ] The `inventory:capture` handler still calls `captureAndSave()` directly
- [ ] A `.catch` exists on the scheduled capture chain
- [ ] `git status --porcelain` shows only `entrypoints/background.ts`

## STOP conditions

Stop and report back (do not improvise) if:

- `entrypoints/background.ts` does not match the "Current state" excerpts — in
  particular if the four `management` listeners are not the four
  `void captureAndSave()` calls shown.
- `git log --oneline -1` does not show `1b12c60` — you are on the wrong base.
  `main` still contains the native companion, and this plan's line references
  and counts assume plan 006 has landed.
- You conclude the debounce needs to survive service-worker termination. It
  does not, for this plan — say so and stop rather than adding alarm-based
  persistence.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- 750 ms is a judgement call, not a measured value. It should be long enough to
  swallow a bulk enable/disable and short enough to feel immediate. If it needs
  tuning later, the constant is the single place to change.
- `captureInFlight` grows a promise chain link per capture. This is bounded in
  practice (captures are user-scale events, not a hot loop) and each link is
  released once settled, so it does not leak. If capture ever becomes
  high-frequency, replace the chain with an explicit "busy + rerun requested"
  flag.
- This plan deliberately leaves the `alarms` permission unused. Either wire a
  periodic capture to it or remove it from the manifest before store submission
  — shipping a declared permission with no consumer is review surface for
  nothing.
- `console.error` is introduced here as the first logging in the codebase. If a
  logging convention is later adopted, this is one of two or three call sites to
  migrate.
- A reviewer should confirm the manual "Scan now" path is genuinely still
  immediate, since debouncing it would be an easy and user-visible mistake.
