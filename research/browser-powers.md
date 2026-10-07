# What can each browser let Cairn do after a user installs an extension?

Research for [#4](https://github.com/t1nk333r/cairn/issues/4), a child of the
guided-restore map [#1](https://github.com/t1nk333r/cairn/issues/1). Researched
2026-10-07.

Evidence tags: **[source]** means read in browser source at a pinned revision.
**[observed]** means reproduced with the harness described in [Method](#method).
**[docs]** means vendor documentation. **[INFERENCE]** means not directly verified.

## Answer

| Question | Chromium / Chrome / Helium | Firefox 157, ESR 140, ESR 153 |
|---|---|---|
| Events for a fresh store install | `onEnabled`, then `onInstalled`. Both carry `enabled: true`. | `onInstalled` only, with `enabled: true`. **No `onEnabled`.** |
| `setEnabled` on an ordinary extension | **Works.** Disabling never needs a gesture or shows a prompt. Enabling needs neither, unless the target is disabled because its permissions increased. That case needs a user gesture and shows Chrome's re-enable dialog. | **Throws** `setEnabled can only be used for themes or by addons installed by enterprise policy`. It works only on themes, or when Cairn itself was installed by enterprise policy. |
| State right after a store install | Enabled | Enabled |
| Permissions needed beyond `management`, `storage`, `bookmarks`, `alarms` | **None** | **None** |

## Versions examined

| Family | Source read at | Run empirically |
|---|---|---|
| Chrome / Chromium | Chrome stable 155.0.8059.39, commit [`3ff7ac5a`](https://chromium.googlesource.com/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34) | Chromium 152.0.7977.82 (Arch) |
| Helium | [`imputnet/helium@860a42de`](https://github.com/imputnet/helium/tree/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48), Chromium [154.0.8037.97](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/chromium_version.txt) | Helium 0.18.3.1 (Chromium 154.0.8037.97) |
| Firefox stable | `release` [`649ad53f`](https://github.com/mozilla-firefox/firefox/tree/649ad53f32558752d0d8b630ac1411f324c99272) | 157.0.1 |
| Firefox ESR | `esr140` [`02f6079d`](https://github.com/mozilla-firefox/firefox/tree/02f6079d3858a90d5533e84edd6fdb7701f58040), `esr153` [`cbcae416`](https://github.com/mozilla-firefox/firefox/tree/cbcae4161dc1425b886bd8759de01a95499a8e56) | 140.17.0esr, 153.4.0esr |

Current versions came from [product-details](https://product-details.mozilla.org/1.0/firefox_versions.json)
and [ChromiumDash](https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Linux&num=1).
Firefox has two supported ESRs right now: 140 and 153. `ext-management.js` is
byte-identical on `release` and `esr153`. On `esr140` it differs only in how it
detects enterprise policy (see §2).

## 1. Which `management` events fire for a user store install, and in what order

### Chromium, Chrome, Helium

- **Order: `onEnabled`, then `onInstalled`.** **[source][observed]**
  - The CWS install path (`CrxInstaller` →
    [`registrar_->OnExtensionInstalled`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/crx_installer.cc;l=1063))
    reaches
    [`AddNewOrUpdatedExtension`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/browser/extensions/chrome_extension_registrar_delegate.cc;l=454-468)
    and then
    [`FinishInstallation`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/extension_registrar.cc;l=807-835).
  - `FinishInstallation` calls `AddExtension`. That runs
    [`AddNewExtension`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/extension_registrar.cc;l=248-268),
    then `ActivateExtension`, then `TriggerOnLoaded`. Only after that does
    `FinishInstallation` call `TriggerOnInstalled`.
  - [`ManagementEventRouter`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=1107-1156)
    maps `OnExtensionLoaded` to `onEnabled`, `OnExtensionUnloaded` to
    `onDisabled`, `OnExtensionInstalled` to `onInstalled`, and
    `OnExtensionUninstalled` to `onUninstalled`.
  - Observed in Chromium 152 and Helium 154: `onEnabled` at +1108.8 ms, then
    `onInstalled` at +1109.5 ms. Both payloads had `enabled: true` and the full
    `permissions` array.
- **An install that lands disabled fires `onInstalled` only, with `enabled:
  false`.** `AddNewExtension` puts it in the disabled set without activating it,
  so no `onEnabled` fires. See §3 for when that happens. **[source]**
- **Updates fire `onDisabled`, then `onEnabled`, then `onInstalled`.** The event
  carries no is-update flag. `AddExtension` first unloads the old version with
  `RemoveExtension(..., UPDATE)`.
  ([L218-L225](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/extension_registrar.cc;l=218-225)).
  **[source, not exercised]**
- **Uninstall fires `onDisabled` (if the extension was enabled), then
  `onUninstalled` with just the id *string*.** **[observed][source L1146-L1147]**
- **Component-location extensions never produce events.** They are also absent
  from `getAll()`: `ShouldExposeViaManagementAPI` returns false
  ([L86-L90](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=86-90)).
  Helium makes one exception (see §5).
- **Delivery while the service worker is asleep.** A listener registered
  synchronously at top level wakes the worker
  ([docs](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/events)).
  **[docs; not exercised, because the worker was awake during the run]**

### Firefox 157, ESR 140, ESR 153

- **Order: `onInstalled` only. No `onEnabled` on a fresh install.**
  **[source][observed in all three]**
  - [`AddonInstall.startInstall`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs#L1925-L2031)
    calls `onInstalling`. It then sets `active = visible && !disabled`,
    writes the database, and calls `onInstalled`. Only after that does it call
    `BootstrapScope.install(...)`, which starts the extension.
  - `onEnabling`/`onEnabled` come only from
    [`updateAddonDisabledState`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs#L3107-L3133),
    and a fresh install never calls it.
  - [`ManagementAddonListener`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/parent/ext-management.js#L107-L171)
    forwards these AddonManager events one-to-one.
- **The `onInstalled` payload is thin.** It is built before the extension starts.
  At that moment `WebExtensionPolicy.getByID()` is still empty, so
  [`getExtensionInfoForAddon`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/parent/ext-management.js#L49-L92)
  leaves out `permissions`, `hostPermissions`, `shortName`, and `icons`.
  Observed: `permissions` was absent in 157, 140, and 153. A later
  `management.get(id)` returns the full record. **[source][observed]**
- **Reinstalling a same-version add-on the user had disabled only re-enables
  it.** That fires `onEnabled` and **no** `onInstalled`
  ([L1884-L1903](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs#L1884-L1903)).
  **[source, not exercised]**
- **Updates fire `onInstalled` only.**
  [`BootstrapScope.update`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/mozapps/extensions/internal/XPIProvider.sys.mjs#L2340-L2391)
  wraps the same `install()` callback and fires no enable or disable events.
  **[source, not exercised]**
- **Uninstall fires `onUninstalled` with a full `ExtensionInfo` object, not an
  id string.** There is no preceding `onDisabled`. This is the opposite of
  Chromium.
  ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/management/onUninstalled)).
  **[observed][docs]**
- **Events wake a suspended event page.** `management` declares all four events
  as
  [`PERSISTENT_EVENTS`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/parent/ext-management.js#L198-L203).
  The same code is in
  [ESR 140](https://github.com/mozilla-firefox/firefox/blob/02f6079d3858a90d5533e84edd6fdb7701f58040/toolkit/components/extensions/parent/ext-management.js#L200).
  Observed: the observer was suspended (idle timeout set to 5 s, then 9 s
  elapsed). An install restarted its background, and the background then
  received `onInstalled`, in all three versions. **[source][observed]**
- **Theme switches fire paired events.** They produce `onEnabled` for the new
  theme and `onDisabled` for the old one (`type: "theme"`). **[observed]**

## 2. Can `management.setEnabled` enable or disable an ordinary extension?

### Chromium, Chrome, Helium: yes

[`ManagementSetEnabledFunction::Run`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=421-616)
checks these cases in order. **[source]**

1. Missing or component-location target: `Failed to find extension with id *`.
2. `ExtensionMayModifySettings(Cairn, target)` is false: `Extension * cannot be
   modified by user.` This covers policy-installed and component targets
   ([policy provider](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/browser/extensions/standard_management_policy_provider.cc;l=32-88)).
3. The target is already in the requested state: success with no change.
4. Supervised (child) profile enabling an unapproved extension: the parent-approval
   flow runs.
5. **Disable:** done immediately. There is no gesture check and no prompt. The
   disable reason recorded is `DISABLE_BY_ANOTHER_EXTENSION`, and Chrome stores
   Cairn's id as the extension that disabled it
   ([L476-L494](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=476-494)).
6. **Enable**, in order:
   - A target that policy says must stay disabled: `cannot be modified by user`.
   - Unsupported requirements are rechecked: `There were missing requirements: *`.
   - **Permission increase**
     ([L542-L573](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=542-573)).
     Without `user_gesture()`, the call fails with `Re-enabling an extension
     disabled due to permissions increase requires a user gesture.` With a
     gesture, Chrome shows its native re-enable install prompt. If the user
     declines, the call fails with `The user did not accept the re-enable
     dialog.`
   - Otherwise the extension is enabled. There is no prompt.

Notes:

- **The Chrome docs overstate the gesture requirement.** The
  [reference](https://developer.chrome.com/docs/extensions/reference/api/management#method-setEnabled)
  says "in most cases this function must be called in the context of a user
  gesture". The source enforces it only on the permission-increase path.
  Chromium does log gesture presence on every call (`UmaHistogramBoolean`,
  [L426](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=426)),
  which could precede a stricter rule. **[INFERENCE]**
- **Only an extension page can carry a gesture.** A call from a
  popup or options-page click handler can have one. A service-worker call never
  does. So a re-enable that may hit a permission increase must run in the
  options page. **[INFERENCE from `user_gesture()` semantics]**
- Observed in Chromium 152 and Helium 154, from the service worker with no gesture:
  `setEnabled(id, false)` succeeded and fired `onDisabled` with
  `disabledReason: "unknown"`, `mayEnable: true`. `setEnabled(id, true)`
  succeeded and fired `onEnabled`. **[observed]**
- `ExtensionInfo.disabledReason` is only ever `"unknown"` or
  `"permissions_increase"`
  ([L164-L179](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=164-179)).
  `mayEnable` reflects policy. **[source]**

### Firefox 157, ESR 140, ESR 153: no, themes only

- [`setEnabled`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/parent/ext-management.js#L304-L335)
  throws `setEnabled can only be used for themes or by addons installed by
  enterprise policy` whenever `addon.type !== "theme"` and the *calling*
  add-on (Cairn) is not policy-installed. **[source][observed in all three]**
  - On 157 and 153, the policy test is
    `Services.policies.isAddonRequiredByPolicy(extension.id)`. Those versions
    also refuse to disable when policy disallows it.
  - [ESR 140](https://github.com/mozilla-firefox/firefox/blob/02f6079d3858a90d5533e84edd6fdb7701f58040/toolkit/components/extensions/parent/ext-management.js#L306-L328)
    tests `extension.isInstalledByEnterprisePolicy` instead.
  - System add-ons are always refused.
- **No user-input requirement.** The schema marks only `install` as
  `requireUserInput`, not `setEnabled`
  ([schema](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/schemas/management.json#L196-L199)).
  MDN says the call "must usually be called in the context of a user action"
  ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/management/setEnabled)),
  but Firefox does not enforce that. Observed: theme toggles from the event page
  with no input succeeded. **[source][observed]**
- **There is no deep link either.** `tabs.create({url: "about:addons"})` is
  rejected with `Illegal URL: about:addons`. That was observed in all three
  versions and matches
  [MDN tabs.create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create).
  Cairn therefore cannot change, or link straight to, an ordinary add-on's
  enabled state on Firefox. It can only observe the change.
- `management.install()` is
  [themes-only and needs user input](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/parent/ext-management.js#L232-L260),
  as `PLAN.md` already notes.

## 3. What enabled state does a freshly installed extension start in?

### Chromium, Chrome, Helium: enabled

[`GetDisableReasonsOnInstalled`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/extension_registrar.cc;l=516-573)
plus the
[Chrome delegate](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/browser/extensions/chrome_extension_registrar_delegate.cc;l=355-383)
give a store install no disable reasons. The exceptions are: **[source]**

- Enterprise policy forces the extension to stay disabled.
- Unsupported requirements.
- An existing disabled prefs entry for the same id. Uninstalling clears it, so
  this does not apply to a true fresh install.
- External or sideloaded installs get `DISABLE_EXTERNAL_EXTENSION`. Store
  installs never do.
- Blocklisted or policy-blocked extensions never load.

Chrome Sync carries enabled state too. An extension that sync installs can
arrive disabled
([`extension_sync_service.cc` L509-L539](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/browser/extensions/sync/extension_sync_service.cc;l=509-539)).
**[source]**

Observed: a CDP unpacked install started with `enabled: true` in Chromium 152 and Helium 154.

### Firefox 157, ESR 140, ESR 153: enabled

A new `AddonInstall` has `userDisabled: false`, and `startInstall` sets
`active = visible && !disabled`
([L1984](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs#L1984)).
Observed: the signed AMO XPI installed with `enabled: true, installType:
"normal"` in all three versions. **[source][observed]**

Add-ons Firefox marks `appDisabled` never become active: incompatible,
blocklisted, or unsigned ones. Sideloaded add-ons (`installType: "sideload"`)
are a different, non-store path. **[INFERENCE: not traced]**

## 4. Which calls need permissions beyond `management`, `storage`, `bookmarks`, `alarms`?

**None.** Cairn's current manifest covers every call that guided restore needs.

| Call | Chromium / Helium | Firefox | Evidence |
|---|---|---|---|
| `management.getAll`, `get`, `setEnabled`, `onInstalled`/`onEnabled`/`onDisabled`/`onUninstalled` | `management` | `management` | [Chromium features](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/common/api/_api_features.json;l=331-374), [Firefox schema](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/toolkit/components/extensions/schemas/management.json#L148-L353) |
| `management.getSelf`, `uninstallSelf` | none | none | same, [Chrome docs](https://developer.chrome.com/docs/extensions/reference/api/management) |
| `tabs.create` for a store page (`chromewebstore.google.com`, `addons.mozilla.org`) | none | none | [Chromium `tabs` feature](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/common/extensions/api/_api_features.json;l=929-933) has no permission dependency, [Chrome tabs docs](https://developer.chrome.com/docs/extensions/reference/api/tabs#permissions), [MDN tabs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs). **[observed]** in all five builds, from the background, without `tabs` |
| `windows.create` | none (depends only on `api:tabs`) | none | [Chromium](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/common/extensions/api/_api_features.json;l=1089-1091) |
| `tabs.create("chrome://extensions/?id=<id>")` | allowed, no permission | n/a; `about:addons` is rejected | [`PrepareURLForNavigation`](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:chrome/browser/extensions/extension_tab_util.cc;l=1116) blocks only `javascript:`, kill URLs, `devtools:`, `chrome-untrusted:`, and `file:` without access. **[observed]** |

Two notes on the table:

- Reading `Tab.url` or `Tab.title` would need `tabs` or a host permission. Opening
  a tab does not.
- No host permission is needed to open store pages.

## 5. Helium specifics

The Helium patches leave the `management` API and the registrar's install flow
untouched, apart from what is listed below. So everything in §1-§4 for Chromium
applies to Helium. **[source][observed]**

- **Store installs depend on Helium services.** Helium sends CWS downloads
  through its services proxy.
  - The proxy is used only when services are enabled and consented *and* the
    `helium.services.ext_proxy` pref (default `true`) is on
    ([proxy patch L186-L192, L257-L279, L420-L450](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/proxy-extension-downloads.patch#L257-L279)).
  - Otherwise the install URL points at a dummy host, and the download fails
    with a dedicated "extension downloads disabled" error
    ([patch](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/ui/add-specific-error-for-disabled-extension-downloads.patch)).
  - A Helium user who opted out of services cannot complete the store step of
    guided restore.
- **Bundled uBlock Origin has a different id.** Helium ships uBO as a
  *component* extension with id `blockjmkbacgjkknlgpkjjiijinjdanf`. The CWS id is
  `cjpalhdlnbpafiamejdnhcphjbkeiagm`
  ([ids](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/ublock-install-as-component.patch#L10-L17)).
  - Helium patches `ShouldExposeViaManagementAPI` so this component appears in
    `getAll()` and produces events
    ([patch L55-L75](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/ui/ublock-show-in-settings.patch#L55-L75)).
    It also blocks `management.uninstall` on it.
  - Under the patched policy, only the user (or uBO itself) may modify it
    ([patch L122-L138](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/ublock-reconfigure-defaults.patch#L122-L138)).
  - Observed in Helium 154: `getAll()` lists it as `installType: "other"`,
    `mayDisable: true`. `setEnabled(blockjmk…, false)` from another extension
    fails with `Extension blockjmkbacgjkknlgpkjjiijinjdanf cannot be modified by
    user.`
- **MV2 still loads in Helium.** ungoogled-chromium's patch makes
  `ManifestV2Handler` stop flagging MV2 extensions
  ([patch](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/ungoogled-chromium/extensions-manifestv2.patch)).
  A Helium inventory can therefore record MV2 extensions that upstream Chrome
  would refuse to install or enable. **[source; Chrome-side refusal is
  INFERENCE from the MV2 `CHECK` in `setEnabled`, [L586-L602](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/api/management/management_api.cc;l=586-602)]**

## Consequences for the guided-restore spec

These are facts the spec has to work with. They are not design decisions.

- **Observing an install.** `onInstalled` is the event both families share.
  Chromium also sends `onEnabled` just before it, and updates fire `onInstalled`
  as well, so the event alone cannot tell an install from an update. Re-reading
  `management.get(id)` or `getAll()` handles every case. That also covers the
  thin Firefox payload, and it is what Cairn's existing listeners already do
  (`entrypoints/background.ts`, `scheduleCapture()`).
- **Applying the recorded enabled state.** Chromium can do it with
  `setEnabled`. To cover permission-increase re-enables, call it from an
  options-page click handler, not the service worker. Firefox cannot do it for
  ordinary extensions. That step becomes "ask the user to toggle it in Add-ons
  Manager" with no deep link, followed by observing `onEnabled`/`onDisabled`.
- **`onUninstalled` argument shape differs.** Chromium passes an id string;
  Firefox passes an `ExtensionInfo`.
- **Helium uBO needs an alias entry.** Helium reports its bundled uBO under the
  component id, which matches neither the CWS id nor AMO's
  `uBlock0@raymondhill.net`. Only an alias can link them, and Cairn cannot
  toggle it.

## Confidence

| Claim | Evidence | Confidence |
|---|---|---|
| Chromium fresh install: `onEnabled` → `onInstalled` | source + observed (unpacked path, same `FinishInstallation` tail as CWS) | High. A real CWS click-install was not exercised. |
| Chromium update order `onDisabled` → `onEnabled` → `onInstalled` | source | Medium-high |
| Chromium `setEnabled` disable/enable without gesture | source + observed | High |
| Chromium permission-increase re-enable needs gesture + prompt | source only; no packed CRX update was staged | High (code is unambiguous) |
| Firefox fresh install: `onInstalled` only, thin payload | source + observed (signed AMO XPI through `AddonInstall.startInstall`, the path AMO uses) | High |
| Firefox `setEnabled` themes/policy only | source + observed 157/140/153 | High. The policy-installed exception was not exercised. |
| Firefox events wake a suspended event page | source + observed | High |
| No extra permissions | source + docs + observed | High |
| Helium uBO exposure and immutability | source + observed | High |
| Helium store install needs services + ext proxy | source only | Medium-high |

## Method

- **Observer extension.** An MV3 observer extension used exactly Cairn's
  permissions (`management`, `storage`, `bookmarks`, `alarms`). It had no `tabs`
  and no host permissions. It registered all four `management` listeners at top
  level and POSTed every event to a localhost HTTP server. It also polled that
  server for commands (`get`, `getAll`, `setEnabled`, `tabs.create`) and ran
  them from its background context with no user gesture. The server sent
  `Access-Control-Allow-Origin: *`, so no host permission was needed.
- **Chromium and Helium.** Run headless with `--remote-debugging-pipe
  --enable-unsafe-extension-debugging`. Both extensions were loaded with CDP
  `Extensions.loadUnpacked`. `UnpackedInstaller` reaches the same
  `OnExtensionInstalled` → `AddNewOrUpdatedExtension` → `FinishInstallation`
  path as `CrxInstaller`
  ([L463](https://source.chromium.org/chromium/chromium/src/+/3ff7ac5a9224be9156d7f8703a06e22890aafd34:extensions/browser/unpacked_installer.cc;l=463)).
  Only the install location differs, so `installType` reported `development`.
- **Firefox.** Run headless with Marionette.
  - The observer was installed temporarily.
  - `extensions.background.idle.timeout` was set to 5000 ms, and the harness
    waited 9 s so the observer suspended.
  - The target was the signed AMO XPI of SingleFile 1.28.1
    (`{531906d3-e22f-4a6c-a102-8057b88a1a63}`), installed non-temporarily.
    Marionette's
    [`Addon.installWithPath`](https://github.com/mozilla-firefox/firefox/blob/649ad53f32558752d0d8b630ac1411f324c99272/remote/shared/Addon.sys.mjs#L54-L65)
    uses `getInstallForFile` → `install()`. That is the same
    `AddonInstall.startInstall` an AMO click reaches, minus the permission
    doorhanger.
- **Not exercised:**
  - a real CWS or AMO click-through;
  - a permission-increase update on Chromium;
  - the Firefox enterprise-policy exception;
  - Chromium service-worker wake on `management` events.
