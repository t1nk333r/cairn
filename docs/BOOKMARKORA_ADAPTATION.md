# Bookmarkora adaptation

## Why this is the reference

Bookmarkora already validates the product shape Cairn needs: one cross-browser
extension, user-owned storage, Git-host APIs, Gitea, WebDAV, S3-compatible
storage, multiple push targets, scheduled sync, merge, snapshots, and optional
end-to-end encryption.

Bookmarkora is MIT-licensed. Cairn may reuse its code if the copyright and MIT
license notice travel with copied portions. Product ideas and architecture will
be adapted openly and credited even where the implementation is new.

The public repository currently exposes packaged extension bundles rather than
an obvious unbundled source tree. Therefore Cairn will not paste minified code.
We will implement readable TypeScript from the observable interfaces and only
copy a specific routine if its provenance and license header can be preserved.

## Architecture observed in Bookmarkora

The packaged Chrome extension uses:

```text
popup.html + React entry
options.html + React entry
             │
             ▼
   background service worker
             │
       sync coordinator
             │
   provider selection/fan-out
      ┌──────┼────────┐
      ▼      ▼        ▼
   Git host Gitea   WebDAV/S3
```

Notable patterns:

- Manifest V3 with separate popup, options page, and service worker.
- A browser namespace shim selecting `browser` or `chrome`.
- One settings model with defaults, validation, and provider-specific fields.
- One primary provider for reads and selectable targets for writes.
- A background message boundary between React UI and privileged APIs.
- Bookmark-change debouncing plus alarm-backed scheduled sync.
- Upload, download, and three-way merge as distinct operations.
- Local/remote snapshots before destructive or high-risk operations.
- Per-provider auto-sync mode, interval, and notification preferences.
- Runtime optional host permissions for self-hosted endpoints.
- Internationalization through `_locales`.
- Dynamic chunks for less-common providers.

## Direct mapping to Cairn

| Bookmarkora concept | Cairn adaptation |
|---|---|
| Bookmark tree adapter | Normalized extension inventory adapter |
| Chrome/Firefox root differences | Chrome/Firefox extension-ID aliases |
| Bookmark merge | Device-observation and tombstone merge |
| Sync bookmarks | Sync extension inventory |
| Upload | Publish this device's latest observation |
| Download | Pull remote state without installing silently |
| Clear local | Not offered; Cairn must not bulk-uninstall extensions |
| Clear remote | Archive then reset remote inventory |
| Bookmark snapshots | Inventory snapshots and backend version history |
| Broken-link/duplicate tools | Unmatched identity, stale source, and duplicate alias tools |
| Primary target | Authoritative read target |
| Push targets | Optional mirrors written after the primary succeeds |
| Provider badges | Git/Gitea/WebDAV/S3 status badges |
| Auto-sync on bookmark events | Auto-sync on management install/uninstall/enable/disable events |
| Merge preview | Extension additions, removals, state changes, and alias conflicts |
| E2E encryption | Encrypted canonical inventory envelope |

## UI design to adopt

Bookmarkora uses a compact, native-feeling popup and a larger settings surface.
Cairn will preserve that hierarchy:

### Popup

```text
┌────────────────────────────────────┐
│ Cairn                    ⚙   ↗     │
│                                    │
│ ● Synced 2 min ago                 │
│ 17 here  ·  19 remote  ·  2 missing│
│                                    │
│ [ Sync extensions ]                │
│ [ Upload ]             [ Pull ]    │
│                                    │
│ Primary: Gitea    Mirrors: S3 DAV  │
└────────────────────────────────────┘
```

The primary action is merge/sync. Directional actions are secondary and use
plain language. A setup card replaces the controls until a connection passes.

### Control center

```text
┌──────────────┬─────────────────────────────────────┐
│ Cairn        │ Overview                            │
│              │                                     │
│ Overview     │ [health] [local] [remote] [missing] │
│ Extensions   │                                     │
│ Restore      │ Recent activity / conflicts         │
│ Connections  │                                     │
│ Automation   │                                     │
│ Safety       │                                     │
└──────────────┴─────────────────────────────────────┘
```

Use the same general visual language visible in Bookmarkora's bundle: system
fonts, restrained gray surfaces, 8–12 px radii, pill-shaped status badges,
green success, amber warning, red danger, light/dark color-scheme support, and
brand icons only where they speed provider recognition. Cairn will use its own
name, icon, copy, spacing scale, and color tokens rather than cloning branding.

## Internal Cairn architecture

Bookmarkora's observable coordinator/provider shape becomes explicit packages:

```text
React popup/options
        │ typed runtime messages
        ▼
background orchestrator
        │
        ├── browser inventory adapter
        ├── sync engine
        │     ├── canonicalize
        │     ├── diff
        │     ├── three-way merge
        │     └── tombstones
        ├── snapshot service
        ├── scheduler/debouncer
        └── backend registry
              ├── Git API
              ├── Gitea
              ├── WebDAV
              └── S3
```

UI components never call a provider directly. They send typed commands to the
background orchestrator and subscribe to a small sync-status model. Provider
implementations have no browser-UI dependencies and must pass one shared
contract test suite.

## Configuration model

Bookmarkora's single default-filled settings object is convenient but grows
wide as providers multiply. Cairn will use discriminated records:

```ts
type Connection =
  | { kind: "git-api"; id: string; label: string; config: GitApiConfig }
  | { kind: "gitea"; id: string; label: string; config: GiteaConfig }
  | { kind: "webdav"; id: string; label: string; config: WebDavConfig }
  | { kind: "s3"; id: string; label: string; config: S3Config };

interface SyncRouting {
  primaryConnectionId: string;
  mirrorConnectionIds: string[];
}
```

Public configuration and secret material are stored separately. Exporting
configuration omits secrets unless the user deliberately creates an encrypted
credentials backup.

## What we will improve rather than copy

### Secrets

The inspected Bookmarkora bundle stores its compressed settings model in
browser sync storage, and that model includes provider credentials. Cairn will
store credentials only in local storage, separated from syncable preferences.

### Host permissions

Bookmarkora declares broad optional `*://*/*` access to support arbitrary
self-hosted services. Cairn will request the narrow origin pattern for the
configured endpoint at connection-test time and show which origin is being
granted.

### Concurrency

Every Cairn backend exposes a version token and conditional write. Provider
fan-out records individual outcomes, and mirrors cannot silently replace the
authoritative primary state.

### Domain safety

Bookmark deletion maps poorly to extension management. Cairn will not expose a
bulk “clear local” action and will never convert remote absence directly into
local uninstallation. Removal is represented as a reviewable tombstone.

### Maintainability

The Cairn repository will contain readable source, unit tests, backend contract
tests, migration fixtures, reproducible builds, and a generated third-party
notice. Release archives will not be the only inspectable implementation.

## Implementation order derived from Bookmarkora

1. Build the popup/options/background shell and typed message protocol.
2. Implement settings, local secret storage, connection cards, and runtime host
   permission requests.
3. Implement inventory capture and local snapshots.
4. Implement a provider registry, starting with WebDAV and S3.
5. Add Git API and Gitea using the same registry and contract tests.
6. Add primary-plus-mirror routing and per-target status.
7. Add three-way merge, preview, deletion guards, and restore workflow.
8. Add alarms, management-event debounce, localization, and release packaging.
