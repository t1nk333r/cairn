# hsync implementation plan

## Product contract

The first stable release will provide:

1. Chromium/Helium and Firefox inventory capture.
2. Local-versus-remote comparison.
3. Guided restore using store, update, or project URLs.
4. Enabled/disabled-state reconciliation where the browser permits it.
5. Manual and scheduled backup.
6. Git, Gitea, WebDAV, and S3-compatible storage.
7. Optional client-side encryption before data leaves the browser.

Bookmarks, passwords, history, tabs, and extension-owned settings are outside
the initial scope. This keeps hsync independent of browser account sync and
avoids collecting unrelated sensitive data.

## Browser reality

Both browser families expose an extension-management inventory API. Their IDs
are not portable: a Firefox add-on ID may differ from its Chromium Web Store
ID, and some add-ons exist in only one ecosystem.

Neither browser lets hsync silently install arbitrary ordinary extensions.
Restore is therefore explicit:

1. Identify a missing extension using a known browser-specific ID or alias.
2. Open its trusted store/project page from a user click.
3. Detect installation through the management API.
4. Offer to apply the recorded enabled state through another user action.

Firefox's `management.install()` is useful for signed themes, not ordinary
extensions. Chromium has no equivalent arbitrary-extension install method.

## Repository layout

```text
apps/
  extension/                 shared UI and browser logic
packages/
  core/                      schema, diff, merge, encryption
  browser-adapter/           normalized management API
  backend-contract/          backend interface and errors
  backend-git/               provider-API Git commits
  backend-gitea/             Gitea repository contents API
  backend-webdav/            GET/PUT with ETag preconditions
  backend-s3/                SigV4 GET/PUT with ETag preconditions
native/
  hsyncd/                    optional Go companion for arbitrary Git/keyring
manifests/
  chromium.json              Chromium/Helium MV3 overlay
  firefox.json               Firefox MV3 overlay
tests/
  fixtures/                  portable inventory fixtures
  integration/               backend contract suites
```

The application will be TypeScript with React and Vite, matching Bookmarkora's
proven popup/options split while keeping domain and provider logic outside UI
components. A single shared core will produce separate Chromium and Firefox
packages; browser-only behavior stays behind adapters.

## Inventory schema

The canonical remote document is versioned and deterministic so it produces
useful Git diffs.

```json
{
  "schemaVersion": 1,
  "revision": "018f...",
  "updatedAt": "2026-08-30T08:00:00.000Z",
  "devices": {
    "device-generated-id": {
      "label": "Laptop",
      "browserFamily": "chromium",
      "lastSeenAt": "2026-08-30T08:00:00.000Z"
    }
  },
  "extensions": {
    "portable-generated-id": {
      "name": "Example",
      "aliases": {
        "chromium": ["chromium-extension-id"],
        "firefox": ["firefox-addon-id@example.org"]
      },
      "sources": {
        "chromium": "https://chromewebstore.google.com/detail/...",
        "firefox": "https://addons.mozilla.org/firefox/addon/..."
      },
      "homepageUrl": "https://example.org",
      "stateByDevice": {
        "device-generated-id": {
          "installed": true,
          "enabled": true,
          "version": "1.2.3",
          "observedAt": "2026-08-30T08:00:00.000Z"
        }
      }
    }
  }
}
```

Portable identity resolution is conservative:

1. An existing exact browser-family ID match wins.
2. A user-confirmed alias links Firefox and Chromium records.
3. A unique canonical project/store URL may be proposed as a match.
4. Name-only matches are suggestions and are never merged automatically.

hsync excludes itself from the inventory and records only metadata required to
compare and restore. Permissions and descriptions may be displayed locally but
will not be uploaded by default.

## Backend contract

Every backend implements the same optimistic-concurrency interface:

```ts
interface InventoryBackend {
  read(): Promise<{ data: Uint8Array; version: string } | null>;
  write(input: {
    data: Uint8Array;
    expectedVersion: string | null;
  }): Promise<{ version: string }>;
  testConnection(): Promise<void>;
}
```

`version` maps to a Git blob/commit SHA, Gitea file SHA, WebDAV ETag, or S3
ETag/version ID. A conflict triggers read, three-way merge, review if needed,
and retry. The extension never resolves a conflict using last-write-wins.

### Git

Browsers cannot reliably clone and push to an arbitrary Git remote: SSH is not
available to WebExtensions, and smart HTTP commonly lacks browser CORS support.
The first Git adapter will therefore use a repository-host contents/commit API
over HTTPS. Its configuration is provider-neutral where APIs are compatible.
Truly arbitrary Git remotes are a later feature requiring a separately
installed native companion. The companion uses Native Messaging, Git over SSH
or HTTPS, and the operating-system credential store. It is not required by
Gitea API, WebDAV, S3, or other browser-only backends.

### Gitea

The Gitea adapter uses its repository contents API and a narrowly scoped token.
Each successful write creates a normal commit, providing history and rollback.
Self-hosted origins are requested at runtime as optional host permissions.

### WebDAV

The WebDAV adapter stores one current document plus optional timestamped
snapshots. It uses `GET`, `PUT`, `HEAD`, `If-Match`, and `If-None-Match`.
Basic authentication and bearer tokens are supported over HTTPS only.

### S3-compatible

The S3 adapter supports AWS S3, MinIO, RustFS, Cloudflare R2, and compatible
services through configurable endpoint, region, bucket, key, and path-style
mode. Requests use Signature Version 4. The bucket must allow the extension
origin through CORS. Version IDs are used when the service exposes them;
otherwise the ETag is the concurrency token.

## Secrets and encryption

- Backend secrets stay in local extension storage and never enter the inventory.
- Host access is requested only for the selected endpoint.
- Plain HTTP endpoints are rejected except `localhost` during development.
- Optional encryption uses an authenticated envelope around the canonical JSON.
- The initial portable implementation uses WebCrypto AES-256-GCM with a
  passphrase-derived key, a random salt, and a unique nonce per write.
- The passphrase is held in memory by default. Remembering it is an explicit
  opt-in and carries a clear warning.
- Connectivity tests redact tokens, access keys, signed headers, and payloads.

## Sync and merge behavior

The remote file is the union of observations, not a mirror of whichever device
wrote last. Each device updates only its own state. Deletions are tombstones
with timestamps so an offline device cannot accidentally resurrect removed
records. Old device observations and tombstones are pruned only through an
explicit maintenance action.

Automatic sync runs after management change events and on a modest alarm, with
debouncing and exponential backoff. Manual Backup and Pull remain available.
No network request occurs until the user configures and tests a backend.

## UI

Following Bookmarkora's useful split, hsync has a compact action popup and a
full-page control center. The popup is intentionally operational rather than a
miniature settings page.

The popup contains:

- sync health and last successful run;
- local and remote extension counts;
- the selected primary backend and compact push-target badges;
- **Sync**, **Upload**, and **Pull** actions;
- a visible warning/conflict state and a route to the control center.

The control center has four focused screens:

- **Overview:** last sync, current backend, conflicts, Backup, and Pull.
- **Compare:** installed here, missing here, remote-only, and unmatched items.
- **Restore:** a user-driven queue with source verification and progress.
- **Settings:** device name, backend, encryption, schedule, export/import.

Backend configuration is generated from a typed schema so all providers share
validation, connection testing, redaction, and permission prompts.

As in Bookmarkora, reads come from one explicit primary target while writes may
fan out to several selected push targets. A partial fan-out is reported per
target and never presented as complete success.

## Delivery sequence

### Milestone 1: local cross-browser core

- Scaffold the TypeScript workspace and dual manifest builds.
- Normalize Chromium and Firefox management API results.
- Implement schema validation, deterministic serialization, diff, and merge.
- Build local export/import and Compare UI.
- Test ID aliasing and self-exclusion with fixtures.

Exit condition: the same source packages and runs in Helium/Chromium and
Firefox, exports valid inventories, and compares two fixtures correctly.

### Milestone 2: WebDAV and S3

- Implement the backend contract suites.
- Add WebDAV conditional writes.
- Add S3 SigV4, endpoint variants, CORS diagnostics, and conditional writes.
- Add encrypted envelope support.

Exit condition: two browser profiles can safely merge through WebDAV and each
target S3-compatible service without losing concurrent changes.

### Milestone 3: Git and Gitea

- Implement repository-host Git API primitives.
- Implement and test the explicit Gitea adapter.
- Add commit messages, branch/path configuration, and conflict recovery.
- Document the boundary between API-backed Git and arbitrary Git remotes.
- Scaffold the optional Go native companion and a versioned Native Messaging
  protocol.
- Add arbitrary Git clone/fetch/commit/push with SSH agent and HTTPS-token
  authentication.
- Store companion credentials in the OS keyring and ship registration helpers
  for Chromium-family browsers and Firefox.

Exit condition: every inventory change is auditable as a commit and concurrent
writes produce a reviewable merge instead of overwrite. Arbitrary Git works
through the optional companion; all other backends continue to work without it.

### Milestone 4: guided restore and release hardening

- Add source URL discovery and user-confirmed cross-browser aliases.
- Implement restore queue and installation-event detection.
- Add enabled-state reconciliation.
- Add packaging, reproducible builds, permissions review, migration tests,
  accessibility checks, and store submission assets.

Exit condition: a clean Chromium/Helium or Firefox profile can work through a
remote inventory without hsync claiming or attempting silent installation.

## Test matrix

Browser targets:

- Helium current stable
- Chromium/Chrome current stable
- Firefox current stable and ESR

Storage targets:

- Gitea current stable
- a supported Git hosting contents API
- nginx/Apache WebDAV
- AWS S3
- MinIO
- RustFS
- Cloudflare R2

Each backend runs the same contract tests: empty read, create, update,
authentication failure, permission failure, conflict, malformed remote data,
timeout, retry, encryption, and secret-redaction behavior.

## Decisions needed before Milestone 1 release packaging

These do not block implementation of the core:

1. Confirm the final license (AGPL-3.0-or-later is recommended for a tool aimed
   at self-hosting; MPL-2.0 is the less restrictive alternative).
2. Select the first API-backed generic Git host in addition to Gitea.
3. Decide whether encrypted inventories are opt-in or the default for new
   configurations.
