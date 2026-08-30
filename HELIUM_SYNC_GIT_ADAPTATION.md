# helium-sync-git adaptation

## Decision

`helium-sync-git` proves the right solution for true arbitrary Git: an optional
native process performs Git and credential operations while a browser extension
controls it through Native Messaging.

hsync will adopt that boundary without adopting raw Chromium-profile sync.

```text
Chromium / Helium / Firefox extension
        │
        ├── direct HTTPS ── Gitea API / WebDAV / S3 / host APIs
        │
        └── Native Messaging (optional)
                    │
                 hsyncd
                    ├── Git SSH/HTTPS
                    ├── OS keyring
                    └── local locks/logs
```

Users who choose WebDAV, S3, Gitea API, or a supported repository-host API do
not install `hsyncd`. Users who require an arbitrary Git remote, SSH agent,
1Password SSH agent, or a system keyring install it.

## What the reference implementation does

The linked MIT-licensed project contains:

- a Go synchronization engine;
- a `go-git` transport with SSH-agent, common key-file, and HTTPS-token auth;
- AES-256-GCM with PBKDF2-derived keys;
- operating-system keyring integration;
- per-device identity and local locking;
- checksum-based three-way file comparison;
- atomic temp-file replacement for downloaded files;
- a WXT Manifest V3 extension;
- Chromium Native Messaging framing and progress events;
- scheduled sync, system tray, setup scripts, and service units.

Its browser extension is a thin remote control: it sends commands to a native
host, displays progress, changes toolbar status, and schedules sync alarms.

## What hsync will reuse conceptually

### Native Messaging boundary

Use a small, versioned protocol over the browser's length-prefixed Native
Messaging channel. Standard output is reserved exclusively for protocol frames;
logs go to standard error or a rotating file.

```json
{
  "protocolVersion": 1,
  "requestId": "generated-id",
  "command": "sync",
  "payload": { "connectionId": "git-main" }
}
```

Responses are correlated and typed rather than relying on unstructured status
strings:

```json
{
  "protocolVersion": 1,
  "requestId": "generated-id",
  "event": "completed",
  "result": { "version": "git-commit-sha" }
}
```

Supported commands in the first companion release:

- `hello` / capability negotiation;
- `testConnection`;
- `readInventory`;
- `writeInventory` with expected revision;
- `sync`;
- `getStatus`;
- `cancel`;
- `setSecret` and `deleteSecret` through the OS keyring.

The protocol will never accept arbitrary shell commands or arbitrary local file
paths from the extension.

### Git transport

The companion owns a private working repository in its state directory. It
supports:

- `ssh://` and SCP-style `git@host:owner/repo.git` remotes;
- HTTPS with a keyring-held token;
- configurable branch and inventory path;
- SSH agent, including 1Password when exposed through the normal agent socket;
- explicit known-host verification;
- fetch/rebase-or-merge, deterministic inventory write, commit, and push;
- non-fast-forward detection surfaced as a sync conflict.

Unlike the reference, hsync will not fall back silently from host verification
or treat a failed checkout as permission to create a branch without validation.

### Credentials

The OS keyring is the preferred store for native-companion secrets. Config files
contain only keyring references. Migration removes legacy plaintext only after
the keyring write is verified.

### Reliability

Adopt the useful process lock, cancellation-aware contexts, progress streaming,
checksum verification, and atomic file replacement. Extend them with structured
error codes and recovery guidance suitable for the extension UI.

## What hsync will not copy

### Raw profile synchronization

The reference scans Chromium profile paths including:

- `Preferences` and `Secure Preferences`;
- `History` and `Bookmarks`;
- `Extensions` and `Extension State`;
- `Extension Cookies`;
- `Local Storage` and `Local Extension Settings`.

It can proceed while the Helium profile is locked. hsync will not do this.
Copying live LevelDB files and browser-managed preference data risks corruption,
syncs more private data than an extension inventory requires, and does not map
cleanly to Firefox.

hsync remains metadata-only: browser APIs enumerate installed extensions, and
the native companion transports the canonical inventory file. It never reads a
browser profile directory.

### Background last-writer-wins

The reference resolves unattended file conflicts according to timestamps.
hsync uses optimistic concurrency plus domain-aware three-way merge. An
unresolvable identity or deletion conflict becomes review-required, not an
automatic overwrite.

### Force mode

The reference extension invokes sync with force enabled because the active
Helium profile is locked. hsync has no profile-file operation and therefore
needs no force mode.

### Platform scope

The reference installation path is primarily Helium/Chromium-oriented even
though WXT can build Firefox output. hsync treats Firefox native-host manifests,
extension IDs, packaging, and tests as first-class release requirements.

## Component layout

```text
native/hsyncd/
  cmd/hsyncd/                Native Messaging entry point
  internal/protocol/         framed, versioned request/event protocol
  internal/git/              clone/fetch/commit/push
  internal/keyring/          platform credential store
  internal/inventory/        canonical validation and atomic IO
  internal/lock/             single-operation process lock
  internal/config/           non-secret configuration
  internal/logging/          redacted structured logs
  installers/
    chromium/                native-host registration
    firefox/                 native-host registration
```

The TypeScript extension and Go companion will share JSON Schema fixtures for
protocol and inventory compatibility. Neither side ships a hand-maintained,
independent interpretation of the wire format.

## Security requirements

- Native host allowed-extension IDs are explicit per signed browser package.
- Repository URLs and branches are validated before storage or use.
- HTTPS tokens and encryption secrets never cross back from the companion.
- Logs redact URLs containing credentials, authorization headers, and secrets.
- Git SSH verifies known hosts and provides a deliberate first-connect flow.
- Working directories are permission-restricted and never user-configurable to
  an arbitrary broad path.
- Inventory writes use expected Git revision and fail closed on divergence.
- Native protocol frames have size limits and schema validation.
- Release builds are reproducible and companion binaries are checksummed.

## Revised product modes

| Capability | Browser-only | With `hsyncd` |
|---|---:|---:|
| Chromium/Helium inventory | Yes | Yes |
| Firefox inventory | Yes | Yes |
| Gitea REST API | Yes | Yes |
| WebDAV | Yes | Yes |
| S3-compatible | Yes | Yes |
| Supported Git-host REST API | Yes | Yes |
| Arbitrary Git HTTPS | No | Yes |
| Git SSH / SSH agent | No | Yes |
| OS keyring | No | Yes |
| Browser profile-file copying | No | No |
