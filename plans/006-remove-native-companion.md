# Plan 006: Remove the native companion and return to the browser-only connection model

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git status --porcelain --untracked-files=no`
> Must report no modified tracked files. See the precondition below.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (large deletion; the risk is removing too much, not too little)
- **Depends on**: none (supersedes plan 002, which is REJECTED)
- **Category**: tech-debt
- **Planned at**: commit `2f8fe62`, 2026-08-31

## PRECONDITION — already satisfied, recorded here for the record

This plan **deletes** the SSH Git transport. An in-review SSH slice was sitting
uncommitted in the maintainer's working tree, touching
`native/hsyncd/internal/gittransport/git.go`, its test,
`entrypoints/options/main.tsx`, `README.md`, `PLAN.md`, and
`native/hsyncd/README.md`.

On 2026-08-31 the maintainer explicitly instructed that it be discarded as
superseded by this plan. It was **stashed, not destroyed**:

- `git stash list` → `stash@{0}` "ssh-transport-slice: discarded 2026-08-31 per
  maintainer, superseded by plan 006 (native companion removal)"
- A patch copy was also written to the session scratchpad.

The tracked working tree therefore now matches `2f8fe62` exactly.

Still run `git status --porcelain --untracked-files=no` before starting. **If it
reports any modified tracked file, STOP and report** — that would mean new
uncommitted work appeared after this plan was written, and discarding it is the
maintainer's decision, not yours. Untracked entries (`.claude/`, `HANDOFF.md`,
`plans/`) are expected in the maintainer's checkout and are not present in a
worktree; ignore them.

## Why this matters

The native companion (`hsyncd`) exists to support arbitrary Git remotes over
SSH. Measured against what it delivers, it is the most expensive component in
the project:

- **~1,733 lines** — 1,448 in `native/` plus 285 of extension-side glue —
  against ~3,455 lines for the rest of the extension. Roughly a third of the
  codebase.
- **Eight of the ~25 findings from the 2026-08-31 audit** live in it or exist
  because of it: `git` inheriting the full process environment, the `ssh://`
  hostname validation gap, an orphaned OS-keyring token on remote change, a
  frame-size boundary that terminates the host process, every failed push
  reported as a conflict, the protocol-schema contradiction, TypeScript/Go
  validation drift, and `ExecRunner` — the code that hands credentials to
  `git` — being executed by no test at all.
- **The expensive part is not built yet.** Native-host registration, install,
  and uninstall helpers for Chromium, Helium, and Firefox across supported
  operating systems are still outstanding, and they are the part a user
  actually has to survive before any of it works.

The architecture was adopted from `helium-sync-git`, which synchronizes browser
**profile files** — a real filesystem sync needing atomic replacement, locking,
and checksummed three-way comparison. A native process is clearly justified
there. hsync synchronizes **one JSON document under 768 KB**. The justification
did not transfer with the pattern.

The browser-only model that `BOOKMARKORA_ADAPTATION.md` documents — Git-host
APIs, Gitea, WebDAV, S3, all over HTTPS with tokens — is already implemented and
tested, and covers the same users through a different door: Gitea for the
dominant self-hosted forge, WebDAV for Nextcloud, S3 for MinIO and R2.

What is genuinely lost: a bare Git repository reachable only over SSH with no
web forge in front of it, and SSH-agent authentication instead of a stored
token. That is a real but narrow audience, and it is the deliberate trade being
made here.

**Note on terminology, so it is not repeated in the docs you touch**: `hsyncd`
is not a daemon despite its name. `native/hsyncd/cmd/hsyncd/main.go` reads
stdin until EOF and exits; the browser spawns it per connection. There is no
resident service, port, or autostart to remove — only an installed binary and a
per-browser host-manifest registration.

## Current state

**Whole directory to delete**: `native/` — the Go module (`cmd/`, `internal/protocol`,
`internal/host`, `internal/gittransport`, `internal/secrets`), the shared
protocol schema at `native/protocol/v1.schema.json`, `native/hsyncd/README.md`,
and the host manifest templates under `native/hsyncd/installers/`.

**Extension-side files to delete**:
- `src/native/protocol.ts` (99 lines) — extension-side protocol
- `src/browser/native-service.ts` (142 lines)
- `src/browser/native-git-store.ts` (44 lines)
- `tests/native-protocol.test.ts` (85 lines)

**`src/browser/messages.ts`** — remove the import at line 6 and these request
members (lines 45-56) plus the two response members (lines 65, 67-70):

```ts
import type { NativeGitConfig, NativeHello } from '../native/protocol';
...
  | { type: 'native:detect' }
  | { type: 'native-git:get-config' }
  | { type: 'native-git:test-and-save'; config: NativeGitConfig }
  | { type: 'native-git:pull' }
  | { type: 'native-git:upload' }
  | { type: 'native-git:set-credential'; ... }
  | { type: 'native-git:delete-credential'; remoteUrl: string }
...
  | { ok: true; nativeCompanion: NativeHello }
  | { ok: true; nativeGitConfig: NativeGitConfig | null; nativeGitCredentialStored: boolean }
```

**`entrypoints/background.ts`** — seven handler branches begin at lines 281,
289, 301, 309, 317, 325, 333 (`native:detect`, then the six `native-git:*`).
Also remove the now-unused imports from `../src/browser/native-service` and
`../src/browser/native-git-store`.

**`entrypoints/options/main.tsx`** — the largest surface, ~83 lines mentioning
`native`. Five state hooks at lines 47-49, 82, 87-90; two hydration effects
(the `native-git:get-config` one and the `native:detect` one) around lines
119-137; handlers around lines 390-475; and the connection card that begins at
line 592 (`<section className="connection-card" id="connections">`).

**Note**: `id="connections"` is on the *native Git card specifically*, and the
sidebar nav at line 500 links to `#connections`. Deleting the card removes that
anchor's target. Handle this — see Step 6.

**`wxt.config.ts:12`** — `optional_permissions: ['nativeMessaging'],`

**`package.json`** — the `"test:native": "cd native/hsyncd && go test ./..."`
script.

**`THIRD_PARTY_NOTICES.md`** — has a "helium-sync-git / helium-sync" section and
an "hsyncd keyring dependencies" section. Both state plainly that **no source
has been copied**, so removing them carries no attribution obligation. Keep the
Bookmarkora section untouched.

Repo conventions: Conventional Commits (`git log --oneline`). No lint or
formatter is configured — match surrounding style by hand and do not reformat
adjacent code.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | exit 0, all pass |
| Build (Chrome) | `npm run build` | exit 0 |
| Build (Firefox) | `npm run build:firefox` | exit 0 |
| Residual references | `grep -rin "native\|hsyncd" src/ entrypoints/ tests/ wxt.config.ts` | only unrelated matches |

## Scope

**In scope**:
- Delete: `native/` (entire directory), `src/native/protocol.ts`,
  `src/browser/native-service.ts`, `src/browser/native-git-store.ts`,
  `tests/native-protocol.test.ts`
- Modify: `src/browser/messages.ts`, `entrypoints/background.ts`,
  `entrypoints/options/main.tsx`, `wxt.config.ts`, `package.json`,
  `README.md`, `PLAN.md`, `HELIUM_SYNC_GIT_ADAPTATION.md`,
  `THIRD_PARTY_NOTICES.md`
- Conditionally modify: `.github/workflows/ci.yml` (only if it exists — see Step 8)

**Out of scope** (do NOT touch):
- `HANDOFF.md` — the maintainer's own session document. They will update it.
- `BOOKMARKORA_ADAPTATION.md` — describes the model being *returned to*; it is
  correct as written.
- The four browser backends (`src/backends/webdav.ts`, `s3.ts`, `sigv4.ts`,
  `gitea.ts`, `github.ts`) and their services/stores. **These must keep working
  and must not change.** They are the proof this removal is safe.
- `src/core/`, `src/browser/device.ts`, `src/browser/inventory-store.ts`.
- `plans/` — the reviewer maintains it.
- Any unrelated cleanup, refactor, or reformat.

## Git workflow

- Branch: `advisor/006-remove-native-companion`
- Commits, in this order (keeps the diff reviewable):
  1. `refactor: remove native companion from the extension`  (code)
  2. `chore: delete the hsyncd native companion`             (the `native/` tree + manifest/scripts)
  3. `docs: record the return to a browser-only connection model` (docs)
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Baseline — record what passes before you delete anything

```bash
npm ci && npm test && npm run typecheck
```

Record the exact test-file and test counts. Also record
`grep -c "it(" tests/native-protocol.test.ts`.

**Verify**: all exit 0. You will use these numbers in Step 9 to prove you
removed exactly the native tests and nothing else.

### Step 2: Remove the native branches from the background router

In `entrypoints/background.ts`, delete the seven handler branches and the two
now-unused import blocks (`native-service`, `native-git-store`).

Leave every other branch untouched.

**Verify**: `grep -c "request.type ===" entrypoints/background.ts` → the prior
count minus 7. `grep -in "native" entrypoints/background.ts` → no matches.
Typecheck will still fail at this point (other files reference the deleted
types); that is expected until Step 5.

### Step 3: Remove the native message contract

In `src/browser/messages.ts`, delete the `../native/protocol` import, the seven
native request members, and the two native response members.

**Verify**: `grep -in "native" src/browser/messages.ts` → no matches.

### Step 4: Remove the native UI from the control center

In `entrypoints/options/main.tsx`, remove: the five native state hooks, the two
native hydration effects, the native handlers (companion detect, test-and-save,
pull, upload, save credential, delete credential), and the native connection
card at line 592.

**Be surgical.** This file also contains the WebDAV, S3, Gitea, and GitHub
cards, which must remain fully functional. Remove only what is reachable from
the native state and handlers.

**Verify**: `grep -in "native\|hsyncd\|companion" entrypoints/options/main.tsx`
→ no matches. Then confirm the four surviving backends are intact:
`grep -c "connection-card" entrypoints/options/main.tsx` → the prior count minus 1.

### Step 5: Delete the extension-side files

```bash
git rm src/native/protocol.ts src/browser/native-service.ts src/browser/native-git-store.ts tests/native-protocol.test.ts
```

Remove the now-empty `src/native/` directory if git leaves it behind.

**Verify**: `npm run typecheck` → **exit 0**. This is the first point at which
the extension should typecheck cleanly again. If it does not, something still
references the deleted modules — fix that before continuing.

### Step 6: Fix the orphaned `#connections` nav anchor

The sidebar nav at `entrypoints/options/main.tsx:500` links to `#connections`,
whose only target was the native card you deleted in Step 4.

Move `id="connections"` onto the first surviving connection card (the WebDAV,
Gitea, or GitHub card — whichever now appears first in the document), so the
nav link resolves. Do **not** simply delete the nav link; the section still
exists conceptually, it just has a new first card.

**Verify**: `grep -c 'id="connections"' entrypoints/options/main.tsx` → `1`, and
it sits on a `<section className="connection-card">` that is not the deleted one.

### Step 7: Delete the native companion tree and its wiring

```bash
git rm -r native/
```

Then remove `optional_permissions: ['nativeMessaging'],` from `wxt.config.ts`,
and the `"test:native"` script from `package.json`.

**Verify**: `test -d native && echo PRESENT || echo GONE` → `GONE`.
`grep -in "nativeMessaging" wxt.config.ts` → no matches.
`grep -in "test:native" package.json` → no matches.
`node -e "JSON.parse(require('fs').readFileSync('package.json'))"` → exit 0.

### Step 8: Update CI, only if it exists

Check for `.github/workflows/ci.yml`.

- **If it exists**: remove the `native` job (Go tests/vet/build) and the
  `schema` job (which validates the now-deleted
  `native/protocol/v1.schema.json`). Keep the `extension` job exactly as is.
- **If it does not exist**: skip this step and say so in your report. The CI
  workflow lives on an unmerged branch.

**Verify**: if edited, the YAML still parses
(`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` →
exit 0) and `grep -c "hsyncd\|go-version" .github/workflows/ci.yml` → `0`.

### Step 9: Full verification

```bash
npm test && npm run typecheck && npm run build && npm run build:firefox
```

**Verify**: all exit 0. The test count must have dropped by **exactly** the
number of tests in the deleted `tests/native-protocol.test.ts` (from Step 1) —
no more. If any other test disappeared or broke, you removed too much: STOP
and report.

Confirm no residual references:
`grep -rin "hsyncd\|nativeMessaging\|native-git\|NativeHello" src/ entrypoints/ tests/ wxt.config.ts package.json`
→ **no matches**.

### Step 10: Update the documentation to record the reversal

This is not cosmetic — the point is that the decision does not get silently
reopened later.

- **`HELIUM_SYNC_GIT_ADAPTATION.md`**: do **not** delete this file. Rewrite it
  as a record of a reversed decision. State that the native-companion boundary
  was adopted from `helium-sync-git`, then removed on 2026-08-31, and why: that
  project syncs browser profile *files* and needs a native process, whereas
  hsync syncs a single JSON document under 768 KB, for which the browser-only
  HTTPS backends are sufficient. Note what was traded away (arbitrary
  SSH-only Git remotes; SSH-agent auth) and that a user with a bare SSH repo can
  put Gitea in front of it or use WebDAV/S3.
- **`README.md`**: remove the bullets claiming the native companion, arbitrary
  Git HTTPS/SSH transport, keyring-backed tokens, and companion detection.
  Remove `npm run test:native` from the development section and the Go
  toolchain implication. Keep every claim about the four browser backends.
- **`PLAN.md`**: in the Milestone 3 section, mark the native-companion and
  arbitrary-Git items as removed rather than pending, with a one-line reason
  pointing at `HELIUM_SYNC_GIT_ADAPTATION.md`. Do not rewrite unrelated parts
  of the plan.
- **`THIRD_PARTY_NOTICES.md`**: delete the "helium-sync-git / helium-sync"
  section and the "hsyncd keyring dependencies" section. Both state that no
  source was copied, so no attribution obligation survives. **Keep the
  Bookmarkora section exactly as is.**

**Verify**: `grep -rin "hsyncd" README.md PLAN.md THIRD_PARTY_NOTICES.md` → no
matches. `grep -c "Bookmarkora" THIRD_PARTY_NOTICES.md` → at least 1.

### Step 11: Confirm scope

**Verify**: `git status --porcelain` → clean after your three commits.
`git diff --stat 2f8fe62..HEAD -- src/backends/` → **empty**. The four browser
backends must be untouched.

## Test plan

This plan deletes tests rather than adding them. The verification that matters
is that **nothing else broke**:

- The suite passes with exactly the native tests removed and no others.
- `npm run typecheck` exits 0 with no `@ts-ignore` or `any` introduced to make
  it pass. If you needed a cast to get a clean typecheck, you removed something
  incorrectly — STOP and report.
- Both production builds succeed.
- If you can run a browser: load `.output/chrome-mv3/`, open the control
  center, and confirm the four remaining connection cards render and the
  `#connections` nav link scrolls somewhere real. Report honestly if you could
  not.

Do **not** add new tests in this plan.

## Done criteria

ALL must hold:

- [ ] `native/` does not exist
- [ ] The four deleted extension-side files are gone
- [ ] `npm run typecheck` exits 0, with no new casts or `@ts-ignore`
- [ ] `npm test` exits 0; the count dropped by exactly the deleted file's tests
- [ ] `npm run build` and `npm run build:firefox` both exit 0
- [ ] `grep -rin "hsyncd\|nativeMessaging\|native-git\|NativeHello" src/ entrypoints/ tests/ wxt.config.ts package.json` → no matches
- [ ] `grep -c 'id="connections"' entrypoints/options/main.tsx` → `1`, on a surviving card
- [ ] `git diff --stat 2f8fe62..HEAD -- src/backends/` → empty
- [ ] `HELIUM_SYNC_GIT_ADAPTATION.md` still exists and records the reversal
- [ ] `THIRD_PARTY_NOTICES.md` retains the Bookmarkora section
- [ ] Three commits with the specified messages

## STOP conditions

Stop and report back (do not improvise) if:

- `git status --porcelain --untracked-files=no` reports any modified tracked
  file at the start. That would be new uncommitted work postdating this plan;
  discarding it is the maintainer's call, not yours.
- Any test other than those in `tests/native-protocol.test.ts` fails or
  disappears.
- Getting a clean typecheck requires adding a cast, `any`, or `@ts-ignore`.
- You need to modify anything under `src/backends/` or `src/core/`.
- The four browser connection cards do not render after the change.
- You cannot determine which surviving card should carry `id="connections"`.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **This is a deliberate product decision, not cleanup.** hsync now supports
  exactly the Bookmarkora connection model: Git-host APIs, Gitea, WebDAV, and
  S3, all over HTTPS with tokens. If arbitrary SSH Git is ever reconsidered,
  read `HELIUM_SYNC_GIT_ADAPTATION.md` first — it records why this was reversed.
- Removing the companion retires eight of the audit's findings outright. It
  does **not** affect the multi-device schema work in
  `docs/design/inventory-schema-v2.md`; that design is transport-independent
  and still applies to all four remaining backends.
- The `alarms` permission in `wxt.config.ts` is still declared and still unused.
  That is a separate finding and deliberately not touched here.
- A reviewer should focus on `entrypoints/options/main.tsx`: it is the file
  where over-deletion is most likely, and the four surviving backend cards are
  the thing that must still work.
