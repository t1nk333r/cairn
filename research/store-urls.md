# Store URLs per browser family

Research for [#3](https://github.com/t1nk333r/cairn/issues/3), a child of the
guided-restore map [#1](https://github.com/t1nk333r/cairn/issues/1). Gathered
2026-10-07.

**Question.** For Chromium/Chrome, Helium, and Firefox, what trustworthy
store or project page can Cairn derive from the management API's `id`,
`homepageUrl`, `updateUrl`, and `installType`? Can Cairn check that page from
inside the extension before offering it?

Today `inferSourceUrl` (`src/core/inventory.ts:89-98`) does two things. It
returns `https://chromewebstore.google.com/detail/<id>` for every Chromium ID
that matches `[a-p]{32}`. For other IDs it returns `homepageUrl ?? updateUrl`.

## Answer

| Family | Store page | When it is right | Can the extension verify it? |
|---|---|---|---|
| Chrome / Chromium | `https://chromewebstore.google.com/detail/<id>` | Only when `updateUrl` is the Chrome Web Store (CWS) update URL (host `clients2.google.com`, path `/service/update2/crx`) and `installType` is not `development`. | **No** for the store page itself. Chromium blocks extension CORS access to the store even when the extension has host permission, and the store returns HTTP 200 for unknown IDs. **Partly** through the CWS update service, which needs host permission for `clients2.google.com` and is not documented for this use. |
| Helium | The same CWS URL. Helium uses the real CWS website. Only downloads and updates go through Helium's proxy. | The same rule, but Helium rewrites the `updateUrl` that the management API reports. CWS-sourced extensions report `https://services.helium.imput.net/ext`, a custom `<origin>/ext`, or `https://helium-services-are-disabled.qjz9zk/`. They never report `clients2.google.com`. | Same as Chromium. Calling Google directly also bypasses Helium's privacy proxy. |
| Firefox (stable and ESR) | The AMO page from the API `GET https://addons.mozilla.org/api/v5/addons/addon/<guid>/` → `url`. The URL template `https://addons.mozilla.org/firefox/addon/<guid>/` also redirects to the slug page. | When the API returns 200. A 404 means the add-on is not on AMO. A 401 or 403 means it is not public or has only unlisted versions. | **Yes.** No permissions are needed because AMO sends `Access-Control-Allow-Origin: *`. |

Rules that apply to every family:

- **Never offer `updateUrl` as a page.** It is an update-manifest endpoint
  (Omaha XML or Firefox update JSON), or on Helium a proxy endpoint. Today's
  fallback `safeExternalUrl(item.updateUrl)` is wrong for this reason.
- **`homepageUrl` is a developer-controlled project page, not a store
  page.** Any `http`/`https` URL the manifest declares ends up here. Label it
  as the developer's site. Chromium fills this field with the CWS detail URL
  when the extension updates from the store and declares no `homepage_url`
  (see C2).
- **`development` installs never earn a store link.** An unpacked extension
  can claim any CWS ID through `key`, and any CWS `update_url`. We observed
  Chromium and Helium report both the CWS `updateUrl` and a CWS
  `homepageUrl` for such an extension, even though no listing exists (see
  E2).

## Chrome / Chromium

Chromium sources are pinned to
[`chromium/chromium@c2617582`](https://github.com/chromium/chromium/tree/c26175820058a60c06c6877164a23643bdb098b1)
(main, 2026-10-07).

**C1. Where `updateUrl` comes from.** The management API reports
`ExtensionManagement::GetEffectiveUpdateURL()`
([management_api.cc:180-183](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/browser/api/management/management_api.cc#L180-L183)).
That value is an enterprise `override_update_url` if one is set. Otherwise it
is the manifest's `update_url`. A policy override can never be the CWS URL
([extension_management.cc:332-349](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/chrome/browser/extensions/extension_management.cc#L332-L349)).
The CWS adds `update_url` (and `key`) to the manifest of every package it
serves. We observed this on Bitwarden: its
[source manifest](https://github.com/bitwarden/clients/blob/main/apps/browser/src/manifest.v3.json)
has neither field, but the copy installed from CWS has
`"update_url": "https://clients2.google.com/service/update2/crx"` and a
`key`. **Confidence: high** (Chromium source plus one observed install).

**C2. Where `homepageUrl` comes from.** The value is the manifest's
`homepage_url`. If that is absent and the extension updates from the
gallery, Chromium substitutes
`https://chromewebstore.google.com/detail/<id>`. Otherwise the value is an
empty string
([manifest_url_handlers.cc:36-60](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/common/manifest_handlers/manifest_url_handlers.cc#L36-L60),
[management_api.cc:144](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/browser/api/management/management_api.cc#L144)).
"Updates from gallery" is `IsWebstoreUpdateUrl()`, which compares host and
path only and ignores the query
([extension_urls.cc:41-48, 94-96, 158-162](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/common/extension_urls.cc#L158-L162)).
Cairn should use the same host-and-path test.

**C3. What `installType` means**
([management_api.cc:224-246](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/browser/api/management/management_api.cc#L224-L246),
[API docs](https://developer.chrome.com/docs/extensions/reference/api/management#type-ExtensionInstallType)):

| installType | ManifestLocation | Store URL valid? |
|---|---|---|
| `normal` | `kInternal`: a user install from CWS, or a `.crx` dragged in. | Only if `updateUrl` is CWS. A dragged-in off-store CRX is also `normal`. |
| `sideload` | External pref, registry, or pref download. | On Windows and macOS the external `update_url` **must** be CWS. On Linux it can be CWS, a self-hosted XML, or a local CRX ([docs](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)). Decide by `updateUrl`. |
| `admin` | Policy (`ExtensionInstallForcelist` / `ExtensionSettings`). | The entry is `id;update_url`, and CWS is the default. The policy URL is used only for the first install. Later updates use the manifest's `update_url` ([policy definition](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/components/policy/resources/templates/policy_definitions/Extensions/ExtensionInstallForcelist.yaml#L15)). Decide by `updateUrl`. |
| `development` | Unpacked or `--load-extension`. | **No.** The ID comes from the path hash, or from any CWS public key the developer copies into `key` ([docs](https://developer.chrome.com/docs/extensions/reference/manifest/key)). `update_url` is whatever the manifest says. |
| `other` | Component, external component, or invalid location. | **No.** These are bundled by the browser, for example Helium's uBlock Origin (H5). |

**C4. How the CWS URL behaves** (observed 2026-10-07 with `curl`):

- `/detail/<id>` returns a 301 to `/detail/<slug>/<id>`. Example: the live
  `ddkjiahejlhfcafbddmgiahcphecmpfh` redirects to
  `/detail/ublock-origin-lite/…`.
- An unknown ID (`aaaabbbbccccddddeeeeffffgggghhhh`) or a removed one
  (`cjpalhdlnbpafiamejdnhcphjbkeiagm`, uBlock Origin MV2) returns a 301 to
  `/detail/empty-title/<id>`, and that page answers **HTTP 200** with the
  generic title "Chrome Web Store". The store has a soft 404, not a real one.
- The legacy URL `https://chrome.google.com/webstore/detail/<id>` returns a
  301 to the new host.
- Unlisted items open for anyone who has the URL. Private items open only
  for trusted testers, groups, or the publishing domain
  ([CWS visibility](https://developer.chrome.com/docs/webstore/cws-dashboard-distribution)).

The template cannot send the user to the *wrong* listing, because the page
for an ID is Google's own page for that key. Its failure mode is a dead
page. **Confidence: high** for the redirect behaviour. The `empty-title`
slug is undocumented, so we rate it **medium** as a long-term signal.

## Helium

Sources are pinned to
[`imputnet/helium@860a42de`](https://github.com/imputnet/helium/tree/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48)
and
[`imputnet/helium-services@a306151c`](https://github.com/imputnet/helium-services/tree/a306151c83dab82582ecffcbd5b36c9bb59cc44d).
The local observations came from Helium 0.18.3.1 (Chromium 154.0.8037.97).

**H1. Helium's store is the real CWS website.** Helium injects a built-in
component content script on `https://chromewebstore.google.com/*`. The script
removes the "Switch to Chrome" prompts and rewrites the install button text
from "Chrome" to "Helium"
([fixups-chrome-webstore-script.patch:18, 53](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/fixups-chrome-webstore-script.patch#L18)).
The page URL and the extension IDs are therefore identical to Chrome's. The
detail-URL prefix is not patched, and `extension_urls.cc` is not on Helium's
`domain_substitution.list`. **Confidence: high.**

**H2. Installs and updates go through Helium's proxy, not Google.**
`WebstoreInstaller` builds its download URL from
`helium::GetExtensionUpdateURL()` instead of the CWS URL
([proxy-extension-downloads.patch:436-450](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/proxy-extension-downloads.patch#L436-L450)).
The proxy is an Omaha-compatible service at `services.helium.imput.net/ext`
([handlers.ts:37-71](https://github.com/imputnet/helium-services/blob/a306151c83dab82582ecffcbd5b36c9bb59cc44d/svc/extension-proxy/lib/handlers.ts#L37-L71),
[README](https://github.com/imputnet/helium-services/blob/a306151c83dab82582ecffcbd5b36c9bb59cc44d/svc/extension-proxy/README.md)).

**H3. Helium rewrites `updateUrl` as the management API reports it.**

- `ManifestURL::GetUpdateURL` maps any `clients2.google.com` URL to a
  placeholder
  ([patch:8, 67-75, 101-110](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/proxy-extension-downloads.patch#L67-L75)).
- `ExtensionManagement::GetEffectiveUpdateURL` turns that placeholder into
  `helium::GetExtensionUpdateURL(prefs)`
  ([patch:488-497](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/proxy-extension-downloads.patch#L488-L497)).
- That function returns `<services origin>/ext`. When services are disabled,
  consent was not given, or the extension proxy is off, it returns the dummy
  origin instead
  ([patch:266-272](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/proxy-extension-downloads.patch#L266-L272)).
- The default origin is `https://services.helium.imput.net` and the dummy
  origin is `https://helium-services-are-disabled.qjz9zk`
  ([services-prefs.patch:516-563](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/services-prefs.patch#L559-L563)).
  Users can set their own services origin.

We observed the result: a Bitwarden install from CWS reports
`installType: "normal"` and `updateUrl: "https://services.helium.imput.net/ext"`.
A check like `updateUrl === CWS` therefore misses **every** CWS extension on
Helium. **Confidence: high.**

**H4. Helium still fills `homepageUrl` with the CWS URL.**
`UpdatesFromGallery()` compares the patched placeholder against itself, so
the gallery test stays true. The CWS detail URL is still substituted when
`homepage_url` is absent. We observed this on the unpacked probe in E2.

**H5. Helium bundles uBlock Origin as a component.** It reports ID
`blockjmkbacgjkknlgpkjjiijinjdanf` with `installType: "other"` and no
`updateUrl`. CWS does not know this ID (the update service answers
`error-unknownApplication`, and the page redirects to `empty-title`).
Today's template emits a dead CWS link for it.

**H6. With the proxy off, CWS installs fail in Helium.** The settings text
says: "When disabled, downloading and updating extensions will not work"
([patch:230](https://github.com/imputnet/helium/blob/860a42de0aaf10eeb8e5f009b9f1967fa3d13a48/patches/helium/core/proxy-extension-downloads.patch#L230)).
**[INFERENCE]** Cairn could detect this state when any CWS-sourced extension
reports the `helium-services-are-disabled.qjz9zk` host. We did not observe
this; it is read from the code.

## Firefox (stable and ESR)

Sources are pinned to
[`mozilla-firefox/firefox@cfd140a3`](https://github.com/mozilla-firefox/firefox/tree/cfd140a311d8523d3d35e00ee1a9f2403c033dfd).
The local observations came from Firefox Developer Edition 158.0b4. The
management code is shared across channels.
**[INFERENCE]** ESR differs only by age, and every field cited here is
long-standing.

**F1. What the management fields mean**
([ext-management.js:36-92](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/components/extensions/parent/ext-management.js#L36-L92)):

- **`installType`**:
  - `development` means a temporary add-on.
  - `sideload` means `foreignInstall`.
  - `other` means a system add-on, but `getAll()` filters system add-ons out
    ([L97-105](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/components/extensions/parent/ext-management.js#L97-L105),
    [L223-229](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/components/extensions/parent/ext-management.js#L223-L229)).
  - `admin` means the add-on is required by policy.
  - Anything else is `normal`.
- **`updateUrl`** is only `browser_specific_settings.gecko.update_url`
  ([XPIInstall.sys.mjs:508](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs#L508)).
  A policy `update_url` is used for update checks but is not reported
  ([XPIInstall.sys.mjs:3179-3191](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/mozapps/extensions/internal/XPIInstall.sys.mjs#L3179-L3191)).
- **`homepageUrl`** is the manifest's `homepage_url`. If that is absent, it
  is the **developer homepage** from AMO's cached metadata, not the AMO
  listing
  ([XPIDatabase.sys.mjs:1550-1563, 1663-1712](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/mozapps/extensions/internal/XPIDatabase.sys.mjs#L1550-L1563),
  [AddonRepository.sys.mjs:753-755](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/mozapps/extensions/internal/AddonRepository.sys.mjs#L753-L755)).
  Firefox does hold `amoListingURL` internally, but the management API does
  not expose it.

We observed the sideloaded probe report `installType: "sideload"`, with
`updateUrl` and `homepageUrl` exactly as its manifest declared them.

**F2. AMO-listed add-ons have no `updateUrl`.** For non-self-hosted
submissions, AMO's linter rejects `gecko.update_url` with the error
`MANIFEST_UPDATE_URL`
([addons-linter manifestjson.js:590-600, 772-782](https://github.com/mozilla/addons-linter/blob/333abd58c3548f94c412513ae6b37cecda4d4bb9/src/parsers/manifestjson.js#L772-L782)).
Those add-ons update through `extensions.update.url`
(versioncheck.addons.mozilla.org,
[firefox.js:234](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/browser/app/profile/firefox.js#L234)).
A non-empty `updateUrl` therefore means a self-distributed add-on, which
might still be signed by AMO as unlisted. Such add-ons usually have no
public AMO page.

**F3. The AMO API resolves a GUID.** `GET /api/v5/addons/addon/<id|slug|guid>/`
([docs](https://mozilla.github.io/addons-server/topics/api/addons.html#detail))
returns `url` (the absolute, locale-prefixed listing), `slug`, `status`,
`is_disabled`, `homepage`, and other fields. Non-public add-ons, and add-ons
with only unlisted versions, return 401 or 403 with `is_disabled_by_developer`
and `is_disabled_by_mozilla`.

- **Observed:** `uBlock0@raymondhill.net` returns 200 with
  `url: https://addons.mozilla.org/en-US/firefox/addon/ublock-origin/`.
  The brace GUID `{446900e4-…}` resolves to `bitwarden-password-manager`.
  An unknown GUID returns 404 with `{"detail":"Not found."}`.
- **Batch:** `GET /api/v5/addons/search/?guid=a,b,…` returned both add-ons
  in one call.
- The v5 API is "not frozen", and v4 is the frozen alternative
  ([overview](https://mozilla.github.io/addons-server/topics/api/overview.html#api-versions)).

**F4. AMO's CORS headers allow extension origins.** The docs state "All APIs
are available with Cross-Origin Resource Sharing unless otherwise specified"
([overview § Cross Origin](https://mozilla.github.io/addons-server/topics/api/overview.html#cross-origin)).

- **Observed headers:** `Access-Control-Allow-Origin: *` for both
  `Origin: moz-extension://…` and `Origin: chrome-extension://…`, on 200 and
  404 responses alike. The preflight allows `GET`.
- **Observed in browsers:** a `moz-extension://` background page in Firefox
  158 fetched the detail API with **no host permissions** and got response
  type `cors` with status 200, and a readable 404. Chromium 152 and Helium
  154 extensions without host permissions got the same result.
- Firefox's restricted-domain list (which includes AMO) applies to content
  scripts, webRequest, and DNR, not to an extension's own CORS fetch
  ([`IsRestrictedURI` call sites](https://github.com/mozilla-firefox/firefox/blob/cfd140a311d8523d3d35e00ee1a9f2403c033dfd/toolkit/components/extensions/webrequest/ChannelWrapper.cpp)).

**Confidence: high.**

**F5. The URL template works without the API.**
`https://addons.mozilla.org/firefox/addon/<guid>/` returns a 301 to the
locale and then a 302 to the slug page, with raw or percent-encoded braces.
An unknown GUID returns 404. This is observed, undocumented frontend
behaviour (**medium** confidence). Prefer the API's `url`.

**F6. Side finding for aliases.** `GET /api/v5/addons/browser-mappings/?browser=chrome`
maps Chrome IDs to Firefox GUIDs, with CORS `*`
([docs](https://mozilla.github.io/addons-server/topics/api/addons.html#browser-mappings)).
On 2026-10-07 it returned only **70** entries. It is a curated list built for
Firefox's import feature, so it is useful for proposing a few aliases but is
not a general resolver.

## Can Cairn verify a page from inside the extension?

**E1. The CWS detail page: no, on Chromium and Helium.**
`CreateCorsOriginAccessBlockList` adds `chrome.google.com` and
`chromewebstore.google.com`, including subdomains, at **high priority** for
every extension, and host permissions do not override it
([cors_util.cc:111-160](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/common/cors_util.cc#L111-L160)).
No Helium patch touches `cors_util`. We observed it: an extension holding
`host_permissions` for `https://chromewebstore.google.com/*` got
`TypeError: Failed to fetch` on Chromium 152 and Helium 154. Even without
the block, the store answers 200 for unknown IDs (C4). A `no-cors` fetch only
returns an opaque response. **Confidence: high.**

**E2. The CWS update service: possible, but with caveats.** The update
service answers `GET https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=<ver>&x=id%3D<id>%26uc`
with one of three states (observed):

- live: `<app status="ok"><updatecheck codebase="…" version="…">`
- known but not installable for that `prodversion`:
  `<updatecheck status="noupdate"/>` with no `codebase` (the removed uBO MV2)
- unknown: `<app status="error-unknownApplication"/>`

The service sends no CORS headers. With `host_permissions` for
`https://clients2.google.com/*`, extension fetches succeeded on Chromium 152
and Helium 154; without that permission they failed. Cairn already declares
`optional_host_permissions: ["https://*/*"]`, so it can request
`https://clients2.google.com/*` at runtime from a user gesture without
changing the manifest. Caveats:

- The endpoint is Chromium's internal Omaha endpoint, not a documented
  public API.
- Chromium leaves a TODO to block it the same way as the store: "Should we
  also block the webstore update URL here?"
  ([cors_util.cc:157-158](https://github.com/chromium/chromium/blob/c26175820058a60c06c6877164a23643bdb098b1/extensions/common/cors_util.cc#L157-L158)).
- Every lookup sends the ID to Google.
- On Helium, a direct lookup bypasses the privacy proxy the user chose.
  Helium's proxy returns the same XML at `https://services.helium.imput.net/ext/?response=updatecheck…`
  (observed, no CORS headers), which would need its own host permission and
  does not cover custom origins.

**Confidence: high** for the behaviour. Long-term stability is uncertain.

**E3. AMO: yes.** No permissions are needed (F4). A 200 confirms a public
listing. A 404, 401, or 403 means Cairn should not offer an AMO page.

**E4. Probe method (reproducible).** We used throwaway unpacked extensions:

- **Probe 1:** `management.getAll()` posted to a local receiver.
- **Probe 2:** fetches of the three endpoints, once with host permissions and
  once without.

These ran headless in Chromium 152.0.7977.82, in Helium 0.18.3.1 (using a
temporary copy of a profile with one CWS install), and in Firefox
Developer Edition 158.0b4 (unsigned sideloaded XPIs). The spoof extension
was an unpacked MV3 manifest with
`update_url: https://clients2.google.com/service/update2/crx` and no
`homepage_url`.

- **Chromium** reported `installType: development`, the CWS `updateUrl`, and
  `homepageUrl: https://chromewebstore.google.com/detail/hhamaicalclpjmomhjiccknmonkjjagm`.
  That ID does not exist on CWS.
- **Helium** reported the same `homepageUrl`, with
  `updateUrl: https://services.helium.imput.net/ext`.

## What this means for `inferSourceUrl` (hand-off notes, not a code change)

1. **Chromium family.** Return the CWS detail URL only when
   `installType ∈ {normal, sideload, admin}` and `updateUrl` is a webstore
   update URL for this browser:
   - Chrome/Chromium: host `clients2.google.com` and path
     `/service/update2/crx`.
   - Helium: origin `https://services.helium.imput.net` with path `/ext`, or
     host `helium-services-are-disabled.qjz9zk`.

   Otherwise return no store URL. Offer `homepageUrl` only as the
   developer's site.
2. **Firefox.** Return the AMO API's `url` for the GUID when the API returns
   200. That needs a network call, so it is a capture-time or restore-time
   lookup, not a pure function. Otherwise return no store URL. Never return
   `updateUrl`.
3. **Decide sources on the device that observed the extension.** The
   restoring device lacks the `installType` and `updateUrl` context. V1
   documents already persist both fields (`normalizeExtension`), so sources
   can be recomputed from them.

## Open questions for the map

- **Helium detection.** `BrowserFamily` is `chromium` for both Chrome and
  Helium. Cairn can match Helium's update origins with a hardcoded list, but
  a custom services origin is unknowable.
  **[INFERENCE, untested]** Alternatively, a CWS-installed Cairn could read
  `management.getSelf().updateUrl`, which reports this browser's effective
  webstore update URL, proxy included. That only works if Cairn itself ships
  on CWS.
- **Helium with the proxy off.** Should guided restore detect the dummy host
  and warn that CWS installs will fail (H6)?
- **Bundled `other` extensions.** Should Helium's uBO and other component
  extensions be excluded from the inventory, or marked non-restorable?
- **AMO lookup policy.** When does the lookup run (capture, restore, or
  both)? How is the result cached? Is it acceptable that it discloses GUIDs
  to Mozilla from Chromium devices that restore a remote record? Should v4
  (frozen) be used instead of v5?
- **CWS existence check.** Should Cairn skip it by default and rely on the
  observed-install rule, or offer it as opt-in behind a runtime
  `clients2.google.com` permission? We recommend skipping it by default: it is
  undocumented, may be blocked later, leaks IDs to Google, and bypasses
  Helium's proxy.
- **Identity resolution (schema v2 §3).** A Chromium `homepageUrl` may
  already equal the CWS URL (C2). CWS and AMO URLs never match each other, so
  proposing cross-family aliases from a shared URL only works through the
  developer homepage, plus the 70 AMO browser mappings.
