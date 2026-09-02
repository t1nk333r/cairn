# hsync handoff

Last updated: 2026-08-31 (Asia/Riyadh)

## Objective

Build a FOSS extension-inventory synchronizer for Chromium-family browsers
(including Helium) and Firefox. It records installed extensions, compares
inventories, and supports user-guided restore. Required storage transports are
Git, Gitea, WebDAV, and S3-compatible object storage.

The UI and architecture intentionally adapt useful patterns from Bookmarkora.
True arbitrary Git is handled by the optional Go companion `hsyncd`, informed
by `helium-sync-git`, instead of reading or copying browser profile files.

Repository: <https://github.com/t1nk333r/hsync>

## Current Git state

- Branch: `main`
- Last pushed commit: `2f8fe62 feat: add keyring-backed Git authentication`
- The working tree is intentionally dirty with the next SSH transport slice.
- Do not discard, reset, or recreate the files listed below.

Uncommitted SSH work:

- `native/hsyncd/internal/gittransport/git.go`
- `native/hsyncd/internal/gittransport/git_test.go`
- `entrypoints/options/main.tsx`
- `native/hsyncd/README.md`
- `README.md`
- `PLAN.md`
- `HANDOFF.md` (this newly created handoff)

The local SSH changes currently pass Go tests/vet, all 43 extension tests, and
TypeScript checks. Production browser builds were last verified immediately
before this SSH slice and should be rerun before committing it.

## Completed and pushed

In order:

- `d4c5ea6` — optional native Git companion architecture
- `8dcffb4` — Chromium/Helium and Firefox inventory foundation
- `0ae36e1` — JSON import/export and inventory comparison
- `a8b3af3` — conflict-safe WebDAV backend
- `f230fea` — S3-compatible backend with Signature V4
- `eaa6b24` — Gitea repository backend
- `1579988` — GitHub/GitHub Enterprise contents-API backend
- `c1237f7` — Go Native Messaging companion scaffold
- `c23fa6a` — extension-to-companion detection and handshake
- `0b80ee0` — arbitrary public Git HTTPS transport
- `5ceb44d` — native Git settings, Pull, and Commit controls
- `2f8fe62` — OS-keyring-backed HTTPS Git authentication

The browser-only backends and native companion all use optimistic concurrency:
ETag, object version, blob SHA, or Git commit revision must match before a
write. Last-write-wins behavior is deliberately avoided.

## Current SSH slice

The dirty worktree extends native Git remotes from HTTPS to:

- `ssh://[user@]host[:port]/path/repository.git`
- SCP-like `[user@]host:path/repository.git`

Security behavior already implemented locally:

- only HTTPS, `ssh://`, and conservatively validated SCP-like remotes pass;
- option-like usernames, unsafe schemes, embedded passwords, queries, and
  fragments are rejected;
- Git is invoked directly rather than through a user-supplied shell command;
- `GIT_SSH_COMMAND` enables batch mode and strict host-key checking;
- password and keyboard-interactive fallbacks are disabled;
- the existing `SSH_AUTH_SOCK` is used, including 1Password's SSH agent;
- unknown or changed host keys fail closed;
- HTTPS keyring lookups are skipped for SSH remotes;
- the control center hides HTTPS token fields when an SSH remote is selected.

Before committing this slice:

1. Review SCP-like validation and SSH URL normalization once more for argument
   or option-injection edge cases.
2. Run all verification commands below, including both production builds.
3. Run `git diff --check` and inspect the generated manifests.
4. Commit with a message such as `feat: add SSH agent Git transport`.
5. Push `main` and ensure the worktree is clean.

## Architecture map

- Inventory schema/capture: `src/core/inventory.ts`
- Comparison: `src/core/diff.ts`
- Shared backend contract: `src/backends/contract.ts`
- Browser backends: `src/backends/{webdav,s3,gitea,github}.ts`
- Browser services/storage: `src/browser/`
- Background message router: `entrypoints/background.ts`
- Control center: `entrypoints/options/main.tsx`
- Popup: `entrypoints/popup/`
- Browser build configuration: `wxt.config.ts`
- Native host entry point: `native/hsyncd/cmd/hsyncd/main.go`
- Native protocol/framing: `native/hsyncd/internal/protocol/`
- Native command router: `native/hsyncd/internal/host/host.go`
- Native Git transport: `native/hsyncd/internal/gittransport/`
- OS keyring integration: `native/hsyncd/internal/secrets/`
- Shared protocol schema: `native/protocol/v1.schema.json`
- Browser host templates: `native/hsyncd/installers/`

## Security invariants

- Never read or copy browser profile databases or extension data directories.
- Never claim silent installation of arbitrary browser extensions.
- Never put tokens in repository URLs, Git arguments, logs, native responses,
  or extension storage.
- HTTPS tokens are origin-scoped in macOS Keychain, Linux Secret Service, or
  Windows Credential Manager.
- Authenticated HTTPS Git refuses redirects.
- Native stdout contains protocol frames only; diagnostics go to stderr.
- Native frames are limited to 1 MiB; inventories are limited to 768 KiB.
- Repository paths reject traversal, `.git`, and symlink components.
- Native host allow-lists use exact extension IDs and never wildcards.
- Conflicting writes fail and require Pull/Compare before retrying.

## Verification

From the repository root:

```bash
npm test
npm run typecheck
npm run build
npm run build:firefox
GOCACHE=/tmp/hsync-go-cache GOMODCACHE=/tmp/hsync-go-mod-cache npm run test:native
cd native/hsyncd
GOCACHE=/tmp/hsync-go-cache GOMODCACHE=/tmp/hsync-go-mod-cache go vet ./...
GOCACHE=/tmp/hsync-go-cache GOMODCACHE=/tmp/hsync-go-mod-cache go build -o /tmp/hsyncd-test ./cmd/hsyncd
cd ../..
jq empty native/protocol/v1.schema.json
git diff --check
```

Expected browser outputs:

- `.output/chrome-mv3/`
- `.output/firefox-mv3/`

## Important product gaps after SSH

The next major slice should be encrypted remote inventories, followed by safe
cross-device merge and guided restore. The plan currently specifies WebCrypto
AES-256-GCM with a passphrase-derived key, random salt, and a fresh nonce per
write. Encryption must wrap the canonical inventory consistently across every
browser backend and the native Git protocol; do not implement it independently
inside one transport.

Other remaining work:

- native-host registration/install/uninstall helpers for Chromium/Helium and
  Firefox on supported operating systems;
- actual integration tests against Git SSH and HTTPS servers;
- scheduled synchronization, retry/backoff, and conflict review/merge;
- guided store-page restore and enabled-state reconciliation;
- accessibility, packaging, reproducible releases, and store assets;
- final license decision (AGPL-3.0-or-later is currently planned/recommended).

## Documentation and provenance

- `PLAN.md` — product and milestone plan
- `BOOKMARKORA_ADAPTATION.md` — design/architecture adaptation boundary
- `HELIUM_SYNC_GIT_ADAPTATION.md` — native companion boundary
- `THIRD_PARTY_NOTICES.md` — dependency and inspiration notices
- `docs/` — backend setup guides

Preserve unrelated user changes and use `apply_patch` for file edits. Git writes
and network-dependent dependency operations may require explicit approval in
the Codex sandbox.
