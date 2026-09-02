# Plan 003: Make the background message router respond on Chromium

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Base check (run first)**: `git log --oneline -1` must show `1b12c60`
> ("docs: record the return to a browser-only connection model"). If it does
> not, you are on the wrong base — STOP. Then
> `git diff --stat 1b12c60..HEAD -- entrypoints/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md, plans/006-remove-native-companion.md
- **Base branch**: `advisor/006-remove-native-companion` (tip `1b12c60`) — NOT `main`
- **Category**: bug
- **Planned at**: commit `2f8fe62`, 2026-08-31; **refreshed against `1b12c60` (post-006)**, 2026-08-31

## Why this matters

The background script registers one `browser.runtime.onMessage` listener that
handles all 22 message types. It **returns a Promise** and never calls
`sendResponse`, and never returns `true`.

Returning a Promise from `onMessage` is a Firefox (WebExtensions) behavior.
Chromium does not honor it: on Chrome, a listener must either call
`sendResponse` synchronously, or return the literal value `true` to signal that
`sendResponse` will be called later. A returned Promise is ignored, the message
channel closes immediately, and the sender receives `undefined`.

This project does not ship the `webextension-polyfill` that would paper over
the difference. The `browser` global comes from `@wxt-dev/browser`, whose entire
implementation is:

```js
export const browser = globalThis.browser?.runtime?.id
  ? globalThis.browser
  : globalThis.chrome;
```

On Chromium there is no `globalThis.browser`, so `browser` **is** `chrome`, and
raw Chrome semantics apply.

The consequence is that on Chrome — and therefore on Helium, the project's
headline target browser — every UI action fails: scan, pull, upload, test
connection, save credential. Each call site does `response.ok` on `undefined`
and throws `TypeError: Cannot read properties of undefined (reading 'ok')`, or
surfaces "The message port closed before a response was received". Firefox is
unaffected, which is almost certainly why this survived.

Two things hide it. First, `tsc` cannot catch it: the listener is typed as
returning `void`, and both call sites cast the result with
`as Promise<HsyncResponse>`, casting away the `undefined`. Second, no test
imports `entrypoints/`, so nothing exercises the router at all.

**This finding was established by reading, not by running.** Step 1 of this
plan is to confirm it empirically before changing anything.

## Current state

`entrypoints/background.ts:55-279` — one listener, **22** `if (request.type === …)`
branches, each returning a Promise. (It was 29 before plan 006 deleted the
seven native-companion handlers.) The head of it:

```ts
  browser.runtime.onMessage.addListener(
    (request: HsyncRequest): Promise<HsyncResponse> | undefined => {
      if (request.type === 'inventory:capture') {
        return captureAndSave()
          .then((inventory) => ({ ok: true as const, inventory }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
```

and its tail:

```ts
      if (request.type === 'options:open') {
        return browser.runtime
          .openOptionsPage()
          .then(() => ({ ok: true as const }))
          .catch((error: unknown) => ({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }));
      }
      return undefined;
    },
  );
```

Every one of the 22 branches ends with the identical 4-line `.catch` shown
above. `grep -c "request.type ===" entrypoints/background.ts` returns `22`.
Neither `sendResponse` nor `return true` appears anywhere in the file.

The two senders, which both cast away `undefined`:

`entrypoints/options/main.tsx:16-20` (the `sendRequest` function)
```ts
async function sendRequest(request: HsyncRequest) {
  return browser.runtime.sendMessage(request) as Promise<HsyncResponse>;
}
```

`entrypoints/popup/main.tsx:7-9`
```ts
async function send(type: 'inventory:get' | 'inventory:capture' | 'options:open') {
  return browser.runtime.sendMessage({ type }) as Promise<HsyncResponse>;
}
```

The response contract, `src/browser/messages.ts:59-72`, is a union where every
success member carries `ok: true` and the failure member is
`{ ok: false; error: string }`.

Conventions to match: this codebase uses `as const` on the `ok` field so the
union discriminates, prefers `.then()/.catch()` chains over `async/await` inside
the router, and formats errors as
`error instanceof Error ? error.message : String(error)`. Keep all three.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0, all pass |
| Build (Chrome) | `npm run build` | exit 0, creates `.output/chrome-mv3/` |
| Build (Firefox) | `npm run build:firefox` | exit 0, creates `.output/firefox-mv3/` |

## Scope

**In scope**:
- `entrypoints/background.ts`
- `entrypoints/options/main.tsx` — **only** the `sendRequest` function at lines
  18-20. Do not touch anything else in this 842-line file.
- `entrypoints/popup/main.tsx` — **only** the `send` function at lines 7-9.

**Out of scope** (do NOT touch):
- The bodies of the 22 handler branches — their logic is correct; only the
  plumbing that delivers their result is broken. Do not rewrite, reorder, or
  "improve" them.
- `src/browser/messages.ts` — the response union is fine as-is.
- The rest of `entrypoints/options/main.tsx`, including its React state,
  effects, and the four backend forms. A separate plan covers those.
- Adding `webextension-polyfill`. It would also fix this, but it changes the
  runtime for every API in the project and is a much larger blast radius than
  the problem warrants.
- Debouncing the `management.on*` listeners (near `background.ts:50-53`) — that is
  a real but separate defect, covered by plan 004.

## Git workflow

- Branch: `advisor/003-chromium-message-channel`, created **from `advisor/006-remove-native-companion`**
- Commit per step or as one logical unit; message:
  `fix: respond to extension messages on chromium`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the bug empirically BEFORE changing anything

Do not skip this. The rest of the plan is premised on it.

```bash
npm ci && npm run build
```

Load `.output/chrome-mv3/` as an unpacked extension in a Chromium-family
browser (`chrome://extensions` → Developer mode → Load unpacked). Open the
extension's popup and click the scan/refresh action. Open the popup's devtools
console.

**Verify**: you observe a failure — either a `TypeError` mentioning `ok`, or a
message-port/"could not establish connection" error. Record the exact text.

If instead **everything works correctly**, the premise is wrong: this Chromium
build honors promise-returning listeners. **STOP and report** — do not apply
the fix, because the diagnosis would be wrong and the fix would be unjustified
churn.

If you cannot run a browser in your environment, say so explicitly in your
report and proceed to Step 2, flagging that Step 1 was not completed. Do not
claim you verified something you did not.

### Step 2: Restructure the listener to dispatch through one async handler

Refactor `entrypoints/background.ts` so the 22 branches live in a function that
returns a Promise, and the listener itself is a thin adapter that satisfies
Chrome's contract.

Target shape:

```ts
  function handleRequest(request: HsyncRequest): Promise<HsyncResponse> | undefined {
    // ... the existing 22 `if (request.type === ...)` branches, unchanged ...
    return undefined;
  }

  browser.runtime.onMessage.addListener(
    (
      request: HsyncRequest,
      _sender: unknown,
      sendResponse: (response: HsyncResponse) => void,
    ) => {
      const result = handleRequest(request);
      if (!result) return undefined;
      result.then(sendResponse, (error: unknown) => {
        sendResponse({
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return true;
    },
  );
```

Three requirements:

1. **Move the branches verbatim.** Do not edit their contents. The only change
   is that they now live inside `handleRequest` rather than the listener.
2. **`return true` must be the listener's return value** whenever a handler
   matched. This is the part Chrome requires. For an unmatched message type,
   return `undefined` so other listeners (and the sender's error handling) still
   behave sensibly.
3. **Keep the rejection guard.** Every branch already has its own `.catch`, so
   the outer rejection path should be unreachable — but it must exist, because
   without it a bug in a `.catch` becomes a silently dropped response.

**Verify**: `npm run typecheck` → exit 0. Then
`grep -c "request.type ===" entrypoints/background.ts` → `22` (you must not
have lost or duplicated a branch). Then
`grep -n "return true" entrypoints/background.ts` → exactly one match, inside
the listener.

### Step 3: Stop the call sites from casting away `undefined`

The two senders currently lie to the type system. Make them honest, so this
class of bug cannot hide again.

In `entrypoints/options/main.tsx`, replace lines 18-20 with:

```ts
async function sendRequest(request: HsyncRequest): Promise<HsyncResponse> {
  const response = (await browser.runtime.sendMessage(request)) as
    | HsyncResponse
    | undefined;
  if (!response) {
    throw new Error('The background service did not respond. Try again.');
  }
  return response;
}
```

In `entrypoints/popup/main.tsx`, replace lines 7-9 with the same shape, keeping
its narrower parameter type:

```ts
async function send(
  type: 'inventory:get' | 'inventory:capture' | 'options:open',
): Promise<HsyncResponse> {
  const response = (await browser.runtime.sendMessage({ type })) as
    | HsyncResponse
    | undefined;
  if (!response) {
    throw new Error('The background service did not respond. Try again.');
  }
  return response;
}
```

Both callers already wrap their calls in try/catch and surface `error` state, so
the thrown error becomes a visible message instead of a `TypeError`.

**Verify**: `npm run typecheck` → exit 0. Then
`grep -n "as Promise<HsyncResponse>" entrypoints/` → **no matches**.

### Step 4: Verify on both browsers

```bash
npm test && npm run build && npm run build:firefox
```

Reload the unpacked `.output/chrome-mv3/` build in Chromium. Repeat the Step 1
action (popup scan). Then exercise one round trip from the options page — open
the control center and confirm the extension list populates.

**Verify**: the action that failed in Step 1 now succeeds, and the console shows
no `TypeError` and no message-port error. If you could not complete Step 1, say
so and report what you could check.

Load `.output/firefox-mv3/` in Firefox (`about:debugging` → This Firefox → Load
Temporary Add-on → select `manifest.json`) and repeat.

**Verify**: Firefox behavior is unchanged — the popup and options page work as
before. This is the regression check that matters most, since Firefox was the
working platform.

### Step 5: Confirm scope

**Verify**: `git status --porcelain` → exactly three entries:
`entrypoints/background.ts`, `entrypoints/options/main.tsx`,
`entrypoints/popup/main.tsx`. Then
`git diff --stat entrypoints/options/main.tsx entrypoints/popup/main.tsx` →
each should show a small change (roughly 5-9 lines changed), confirming you
touched only the sender functions.

## Test plan

The existing suite does not cover `entrypoints/` at all, and building the
`browser` fixture needed to unit-test the router properly is a larger task
covered by a separate test-coverage plan. Do **not** build that fixture here.

What this plan requires instead:
- The full existing suite still passes: `npm test` → all pass, no new failures.
- Both production builds succeed.
- The manual two-browser check in Step 4 is performed and its result reported
  honestly, including if a browser was unavailable.

If you want to add one cheap automated guard, this is acceptable and in scope:
a test asserting `handleRequest` is exported and returns `undefined` for an
unknown message type. Only add it if `handleRequest` can be imported without
executing `defineBackground` — if that requires restructuring the module, skip
it and note why.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0, with no new failures versus before the change
- [ ] `npm run build` and `npm run build:firefox` both exit 0
- [ ] `grep -c "request.type ===" entrypoints/background.ts` returns `22`
- [ ] `grep -n "return true" entrypoints/background.ts` returns exactly one match
- [ ] `grep -rn "as Promise<HsyncResponse>" entrypoints/` returns no matches
- [ ] The Chromium action that failed in Step 1 now succeeds (or Step 1's
      omission is explicitly reported)
- [ ] Firefox behavior is unchanged
- [ ] `git status --porcelain` shows only the three in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1 shows the extension **working correctly** on Chromium. The diagnosis
  would then be wrong and no change is justified.
- `entrypoints/background.ts` does not match the "Current state" excerpts — in
  particular if `sendResponse` or `return true` already appears in the file.
- The branch count changes from 22 at any point.
- Firefox regresses in Step 4. Returning `true` alongside `sendResponse` is
  valid on both engines, so a Firefox regression means something else is wrong —
  do not "fix" it by special-casing per browser without reporting first.
- You find yourself needing to modify a handler branch body, or any part of
  `options/main.tsx` beyond `sendRequest`.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The rule to preserve: on Chromium, `onMessage` must `return true` whenever a
  response will arrive asynchronously. Any future listener added to this project
  needs the same adapter.
- The `as` casts removed in Step 3 were the reason `tsc` stayed silent through
  this bug. Resist re-introducing a cast at these call sites.
- This plan deliberately leaves the 22 near-identical `.catch` blocks in place.
  Collapsing them into one `respond()` wrapper is a worthwhile follow-up, but
  doing it in the same change would make the diff impossible to review against
  the actual defect.
- A reviewer should scrutinize two things: that no handler branch body was
  altered (diff the branches specifically), and that `return true` is reached on
  every matched path rather than only some.
- Once a `browser` test fixture exists, the highest-value test to add is one
  asserting the listener returns `true` for a known message type — that is the
  exact property that was missing here.
