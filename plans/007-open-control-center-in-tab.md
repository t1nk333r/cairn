# Plan 007: Open the control center in a full tab and remove the popup

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Base check (run first)**: `git log --oneline -1` must show `6dbe067`
> ("fix: coalesce management-event inventory captures"). If it does not, you are
> on the wrong base — STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/006-remove-native-companion.md, plans/004-serialize-inventory-capture.md
- **Base branch**: `advisor/004-serialize-inventory-capture` (tip `6dbe067`) — NOT `main`
- **Category**: dx
- **Planned at**: commit `6dbe067`, 2026-08-31

## Why this matters

The maintainer's requirement, stated directly: the toolbar popup is not
acceptable; clicking the extension icon must open a full tab.

Two things currently prevent that:

1. The action is wired to a popup. The generated manifest contains
   `"action": {"default_title": "hsync", "default_popup": "popup.html"}`. While
   `default_popup` is set, `action.onClicked` never fires.
2. Even the existing "View inventory" route does not open a tab. The generated
   manifest contains `"options_ui": {"open_in_tab": false, "page": "options.html"}`,
   so `openOptionsPage()` renders the control center embedded inside the
   browser's extensions page rather than as a real tab.

The popup is not load-bearing. The control center already does everything the
popup does — it has its own "Scan now" button at
`entrypoints/options/main.tsx:377` which dispatches the same
`inventory:capture` message — plus the extension list, Compare, and all four
backend connection cards. Deleting the popup removes ~90 lines of TSX and a
stylesheet that duplicate functionality available in a better surface.

## Current state

**`entrypoints/popup/`** contains three files to delete: `index.html`,
`main.tsx` (90 lines), `style.css` (40 lines). WXT derives `default_popup` from
the existence of this entrypoint directory, so deleting it removes
`default_popup` from the generated manifest automatically — there is no
`default_popup` string anywhere in the source to edit.

**`wxt.config.ts`** — no `action` or `options_ui` key is configured today; WXT
generates both from the entrypoint directories. The full current file:

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  targetBrowsers: ['chrome', 'firefox'],
  manifest: ({ browser }) => ({
    name: 'hsync',
    description: 'Sync your browser extension inventory using storage you control.',
    version: '0.1.0',
    permissions: ['management', 'storage', 'alarms'],
    optional_host_permissions: [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    browser_specific_settings:
      browser === 'firefox'
        ? {
            gecko: {
              id: 'hsync@t1nk333r.dev',
              strict_min_version: '128.0',
              data_collection_permissions: {
                required: ['none'],
              },
            },
          }
        : undefined,
  }),
});
```

**`entrypoints/background.ts`** — the `options:open` message handler at line 286:

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
```

**The popup is the only sender of `options:open`.** Verified:
`grep -rn "options:open" entrypoints/ src/` matches only the handler above, the
type declaration at `src/browser/messages.ts:44`, and three lines inside
`entrypoints/popup/main.tsx`. Deleting the popup therefore orphans this message
type, and removing it is this change's own debris — in scope.

The router currently has **22** `if (request.type === …)` branches; after
removing `options:open` it must have **21**.

Conventions: `as const` on the `ok` field, `.then()/.catch()` chains in the
router, errors formatted as
`error instanceof Error ? error.message : String(error)`.

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
- Delete: `entrypoints/popup/index.html`, `entrypoints/popup/main.tsx`,
  `entrypoints/popup/style.css` (the whole `entrypoints/popup/` directory)
- Modify: `entrypoints/options/index.html` (add ONE meta tag — see Step 3),
  `entrypoints/background.ts`, `src/browser/messages.ts`
- Modify: `README.md` — only the sentence(s) describing a popup

**Out of scope** (do NOT touch):
- `entrypoints/options/main.tsx` — the control center already works and already
  has its own "Scan now". Do not add anything to it, do not restyle it, do not
  move sections. This plan changes *how the page is reached*, not the page.
  (Note: `entrypoints/options/index.html` IS in scope, for one meta tag only.)
- `wxt.config.ts` — leave it unchanged. An earlier revision of this plan wrongly
  routed the fix through it; see Step 3.
- The 21 surviving message-handler branches.
- `src/backends/`, `src/core/`, `src/browser/` except `messages.ts`.
- The `alarms` permission — still declared and unused; a separate finding.
- Adding a `tabs` permission. `browser.runtime.openOptionsPage()` does not
  require one. If you think you need it, you are taking the wrong approach —
  STOP.

## Git workflow

- Branch: `advisor/007-open-control-center-in-tab`, created **from `advisor/004-serialize-inventory-capture`**
- One commit; message: `feat: open the control center in a tab instead of a popup`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Baseline

```bash
npm ci && npm test && npm run typecheck && npm run build
```

Record the test counts, and record the current generated action/options_ui:

```bash
python3 -c "import json;m=json.load(open('.output/chrome-mv3/manifest.json'));print('action:',m.get('action'));print('options_ui:',m.get('options_ui'))"
```

**Verify**: it prints `default_popup: 'popup.html'` and `open_in_tab: False`.
If it does not, the premise has drifted — STOP and report.

### Step 2: Delete the popup entrypoint

```bash
git rm -r entrypoints/popup
```

**Verify**: `test -d entrypoints/popup && echo PRESENT || echo GONE` → `GONE`.

### Step 3: Make the options page open in a real tab

**CORRECTED 2026-08-31.** An earlier revision of this plan told you to add an
`options_ui` key to `wxt.config.ts`. **That does not work and you must not do
it.** WXT 0.21.4 overwrites `manifest.options_ui` unconditionally *after* your
`manifest()` callback runs — see
`node_modules/wxt/dist/core/utils/manifest.mjs:152-159`:

```js
	if (options) {
		const page = getEntrypointBundlePath(options, wxt.config.outDir, ".html");
		manifest.options_ui = {
			...wxt.config.browser !== "safari" && { open_in_tab: options.options.openInTab ?? false },
```

It is a plain assignment, not a merge, and `open_in_tab` is read only from
`options.options.openInTab`. WXT populates that by parsing `manifest.*` meta
tags out of the options entrypoint's own HTML — see `importHtmlEntrypoint` in
`node_modules/wxt/dist/core/utils/building/find-entrypoints.mjs:110-130`, which
strips the `manifest.` prefix, converts snake_case to camelCase, and JSON5-parses
the `content` value.

So the meta tag is the only supported mechanism. If you already added an
`options_ui` block to `wxt.config.ts`, **revert it** — leaving it in place is
dead configuration that misleads the next reader.

Add exactly one line to `entrypoints/options/index.html`, inside `<head>`,
alongside the existing meta tags:

```html
    <meta name="manifest.open_in_tab" content="true" />
```

Change nothing else in that file, and do not touch
`entrypoints/options/main.tsx`.

**Verify**: `npm run build` → exit 0, then re-run the manifest inspection from
Step 1. It must now print `open_in_tab: True`, and `action` must no longer
contain `default_popup` (it should be `None` once the popup entrypoint is gone).

### Step 4: Open the control center when the toolbar icon is clicked

With `default_popup` gone, `action.onClicked` fires. In
`entrypoints/background.ts`, inside `defineBackground(() => {` and next to the
existing `browser.runtime.onInstalled` listener, add:

```ts
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });
```

Use `openOptionsPage()` rather than `tabs.create` — it needs no extra
permission and focuses an already-open control center tab instead of opening a
duplicate.

**Verify**: `npm run typecheck` → exit 0. Then
`grep -c "action.onClicked" entrypoints/background.ts` → `1`.

### Step 5: Remove the now-orphaned `options:open` message

Deleting the popup removed the only sender. Remove:
- the handler branch in `entrypoints/background.ts` (at/near line 286)
- the `| { type: 'options:open' };` member in `src/browser/messages.ts:44`
  (mind the union punctuation — the preceding member must still terminate the
  type correctly)

**Verify**: `grep -rn "options:open" entrypoints/ src/` → **no matches**. Then
`grep -c "request.type ===" entrypoints/background.ts` → `21`. Then
`npm run typecheck` → exit 0.

### Step 6: Update the README

Remove or reword only the sentences that describe a popup surface. Search with
`grep -in "popup" README.md`. The control center is now reached by clicking the
toolbar icon; say that instead. Do not restructure the README.

**Verify**: `grep -in "popup" README.md` → no matches, or only matches that are
accurate after your edit (report which).

### Step 7: Full verification

```bash
npm test && npm run typecheck && npm run build && npm run build:firefox
```

**Verify**: all exit 0. Test count unchanged from Step 1 (no test covers the
popup). Then inspect **both** generated manifests:

```bash
for t in chrome-mv3 firefox-mv3; do python3 -c "
import json;m=json.load(open('.output/$t/manifest.json'))
print('$t action:',m.get('action'));print('$t options_ui:',m.get('options_ui'))"; done
```

**Verify**: neither manifest has `default_popup`; both have
`options_ui.open_in_tab: True`.

### Step 8: Confirm scope

**Verify**: `git status --porcelain` → clean after the commit.
`git diff --stat 6dbe067..HEAD -- entrypoints/options/main.tsx` → **empty**
(the control center component must be untouched), and
`git diff --stat 6dbe067..HEAD -- wxt.config.ts` → **empty**.

## Test plan

No automated test covers the popup or the manifest, and this plan does not add
test infrastructure. Verification is:

- The suite still passes with an unchanged count.
- Both builds succeed and both generated manifests satisfy Step 7.
- If a browser is available: load `.output/chrome-mv3/` unpacked, click the
  toolbar icon, and confirm a **full tab** opens showing the control center
  (not a dropdown, not an embedded page inside `chrome://extensions`). Confirm
  "Scan now" works in that tab. Report honestly if no browser was available.

## Done criteria

ALL must hold:

- [ ] `entrypoints/popup/` does not exist
- [ ] `grep -rn "options:open" entrypoints/ src/` → no matches
- [ ] `grep -c "request.type ===" entrypoints/background.ts` → `21`
- [ ] `grep -c "action.onClicked" entrypoints/background.ts` → `1`
- [ ] `npm run typecheck` exits 0, with no new casts or `@ts-ignore`
- [ ] `npm test` exits 0 with the same count as Step 1
- [ ] Both builds exit 0
- [ ] Neither generated manifest contains `default_popup`
- [ ] Both generated manifests have `options_ui.open_in_tab: true`
- [ ] `git diff --stat 6dbe067..HEAD -- entrypoints/options/main.tsx` is empty
- [ ] `git diff --stat 6dbe067..HEAD -- wxt.config.ts` is empty
- [ ] `entrypoints/options/index.html` differs by exactly one added meta line
- [ ] No `tabs` permission was added

## STOP conditions

Stop and report back (do not improvise) if:

- `git log --oneline -1` does not show `6dbe067`.
- Step 1's manifest inspection does not show `default_popup: 'popup.html'` and
  `open_in_tab: False`.
- Removing `options:open` requires touching a file outside the in-scope list —
  it would mean a sender exists that the analysis missed.
- `browser.action` is unavailable or typechecks as undefined. (It is the MV3
  API on both Chromium and Firefox; if it fails, report rather than reaching for
  `browser.browserAction`, which is MV2.)
- You conclude a `tabs` permission is needed.
- The Firefox build rejects the `open_in_tab` meta tag, or the Firefox manifest
  does not pick it up.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The extension now has exactly one UI surface. Anything previously reachable
  only from the popup (a compact status summary) must live in the control
  center's Overview section.
- `open_in_tab` is settable ONLY via the `manifest.open_in_tab` meta tag in
  `entrypoints/options/index.html`; WXT ignores an `options_ui` key in
  `wxt.config.ts` because it overwrites that field after the config callback.
  The meta tag plus `action.onClicked` is the pairing that
  produces this behavior. Re-adding an `entrypoints/popup/` directory would
  silently restore `default_popup` and stop `onClicked` firing.
- A reviewer should check the generated manifests, not just the source — this
  change is mostly about manifest output, and the source diff alone does not
  show that `default_popup` is gone.
