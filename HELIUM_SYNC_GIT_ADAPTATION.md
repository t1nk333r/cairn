# helium-sync-git adaptation (reversed)

## Status: reversed on 2026-08-31

This document originally recorded the decision to adopt a native-companion
boundary from `helium-sync-git`. That decision was **reversed** on
2026-08-31, per plan 006 (`plans/006-remove-native-companion.md`), and the
native companion (`hsyncd`) was deleted from the codebase. This file is kept,
rewritten, so the reversal — and the reasoning behind it — is not silently
reopened later.

## What was adopted, and why it no longer fits

`helium-sync-git` synchronizes browser **profile files**: `Preferences`,
`Secure Preferences`, `History`, `Bookmarks`, `Extensions`, `Extension State`,
`Extension Cookies`, `Local Storage`, and more, scanned directly off disk while
the profile may be locked. That is a real filesystem-synchronization problem —
it needs atomic replacement, process locking, and checksummed three-way file
comparison — and a native process, outside the browser sandbox, is a
reasonable way to do that work.

hsync does not have that problem. It synchronizes exactly **one JSON
document, under 768 KB**: the extension inventory. Every browser API needed to
produce and consume that document (`browser.management`, `browser.storage`)
is already available to an extension without leaving the sandbox. The native
companion's actual justification — safe, atomic, lock-aware access to
mutable, browser-owned files on disk — never applied to hsync's payload. The
architecture was adopted from the reference project's *pattern*, not from a
requirement hsync actually had.

## Why removal, and not just non-use

The companion was optional and could have been left in place, unused by most
users. It was removed instead of left dormant because, measured against what
it delivered, it was the single most expensive and risk-concentrated part of
the codebase:

- Roughly **1,733 lines** — about a third of the project — for a feature
  (arbitrary SSH/HTTPS Git remotes) that only a narrow slice of users would
  ever need, when Gitea, WebDAV, S3, and Git-host APIs already cover the
  common self-hosted and cloud cases over plain HTTPS.
- **Eight findings** from the 2026-08-31 audit lived in it or existed because
  of it: `git` inheriting the full process environment, an `ssh://` hostname
  validation gap, an orphaned OS-keyring token left behind on remote change, a
  frame-size boundary that could terminate the host process, every failed
  push being misreported as a conflict, a protocol-schema contradiction
  between the TypeScript and Go sides, validation drift between them, and
  `ExecRunner` — the code that hands credentials to `git` — having no test
  coverage at all.
- **The expensive remaining work was still ahead, not behind.**
  Native-host registration, install, and uninstall support for Chromium,
  Helium, and Firefox across the supported operating systems had not been
  built yet, and that is the part a user would have had to get through before
  any of this worked for them.

A live, exercised, but rarely-used native-messaging surface with unresolved
security findings and an unbuilt install path is a liability, not an optional
extra. Deleting it removed all eight findings at once and returned the
project to something that ships entirely inside the browser sandbox.

## What is traded away

Removing the companion gives up two things it uniquely provided, and only
those two:

- **Arbitrary Git remotes reachable only over SSH**, with no web forge
  (Gitea, GitHub, etc.) in front of them — e.g. a bare repository on a
  personal server accessed as `git@host:owner/repo.git`.
- **SSH-agent authentication** (including a forwarded 1Password SSH agent)
  as an alternative to a stored HTTPS token.

A user who currently has only a bare SSH Git repository is not left with
nothing: they can put Gitea (or another Git-host API) in front of it, or use
WebDAV or S3 for the same underlying storage, all of which are implemented
in `src/backends/` today and covered by tests. That is a real but narrow loss
of audience, and it is the deliberate trade this reversal makes.

## Current model

hsync is now browser-only. It supports exactly the connection model that
`BOOKMARKORA_ADAPTATION.md` describes: Git-host APIs, Gitea, WebDAV, and S3,
all over HTTPS with tokens, all implemented under `src/backends/` and
`src/browser/`. There is no native process, no OS keyring dependency, and no
`nativeMessaging` permission.

## If this is ever reconsidered

Read this document first. The trade-off has not changed since 2026-08-31:
native-companion complexity and its associated security surface, against
support for arbitrary SSH-only Git remotes and SSH-agent auth for a narrow
audience that already has Gitea, WebDAV, and S3 as alternatives. Any renewed
proposal should explain what has changed about that trade-off, not just that
the feature would be nice to have again.
