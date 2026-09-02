# Plan 001: Establish a working verification baseline (CI + reproducible install)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2f8fe62..HEAD -- package.json .github/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2f8fe62`, 2026-08-31

## Why this matters

This repository has no CI of any kind — there is no `.github/` directory. The
only verification story is a nine-command checklist a human must remember,
written in `HANDOFF.md`. Worse, that checklist currently cannot be completed:
in a fresh-ish checkout `npm test` and both production builds fail before
running a single test, because npm's optional-dependency resolution bug leaves
`node_modules/@rolldown/` without the platform binding for the host machine.

The consequence is that right now **no change to this repository can be shown
to work**. Every other plan in this directory depends on being able to verify a
fix. This plan must land first.

The lockfile is not at fault — `package-lock.json` lists every platform
binding. `npm ci` installs from the lockfile cleanly and sidesteps the bug,
which is also why CI is the durable fix rather than a local workaround.

## Current state

- `.github/` — **does not exist**. No workflow, no CI, nothing runs on push.
- `package.json` — declares the scripts below and **no `engines` field**, so
  nothing pins the Node version:

```json
  "scripts": {
    "dev": "wxt",
    "dev:firefox": "wxt -b firefox",
    "prepare": "wxt prepare",
    "build": "wxt build",
    "build:firefox": "wxt build -b firefox",
    "zip": "wxt zip",
    "zip:firefox": "wxt zip -b firefox",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:native": "cd native/hsyncd && go test ./...",
    "test:watch": "vitest"
  },
```

- `native/hsyncd/go.mod:3` — `go 1.24`.
- `HANDOFF.md:123-139` — the manual checklist this workflow replaces. It runs
  the Go commands with `GOCACHE=/tmp/hsync-go-cache GOMODCACHE=/tmp/hsync-go-mod-cache`
  prefixes. Those are a sandbox workaround for the original author's
  environment; **do not** copy them into the workflow. GitHub runners have a
  writable default Go cache, and `actions/setup-go` manages it.

Repo conventions to match: this project has no lint or formatter configured, so
do not add one in this plan (that is deliberate scope control, not an
oversight). Commit messages follow Conventional Commits — see
`git log --oneline`, e.g. `feat: add keyring-backed Git authentication`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0, no missing-binding error |
| Typecheck | `npm run typecheck` | exit 0, no output |
| Tests | `npm test` | exit 0, all tests pass |
| Build (Chrome) | `npm run build` | exit 0, creates `.output/chrome-mv3/` |
| Build (Firefox) | `npm run build:firefox` | exit 0, creates `.output/firefox-mv3/` |
| Go tests | `cd native/hsyncd && go test ./...` | exit 0, all `ok` |
| Go vet | `cd native/hsyncd && go vet ./...` | exit 0, no output |
| Schema is valid JSON | `jq empty native/protocol/v1.schema.json` | exit 0, no output |

## Scope

**In scope** (the only files you should modify or create):
- `.github/workflows/ci.yml` (create)
- `package.json` (add an `engines` field only — do not touch scripts or deps)

**Out of scope** (do NOT touch, even though they look related):
- `README.md`, `PLAN.md`, `HANDOFF.md` — these have uncommitted local edits in
  the maintainer's working tree. Editing them here causes a merge conflict.
  Documentation fixes are handled by a separate plan.
- Any lint/formatter config — deliberately deferred; adding one now would
  reformat files that are under active review.
- `vitest.config.ts` and coverage tooling — deferred until test gaps are closed.
- Any source file under `src/`, `entrypoints/`, or `native/`.

## Git workflow

- Branch: `advisor/001-verification-baseline`
- One commit; message: `ci: add build and test workflow`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the install problem is real and that `npm ci` fixes it

Run `npm ci`. This reinstalls from the lockfile.

**Verify**: `npm ci` → exit 0. Then `ls node_modules/@rolldown/` → must list a
binding directory matching this machine's platform (e.g.
`binding-linux-x64-gnu` on Linux x64). If `@rolldown` is absent entirely, the
install did not work — that is a STOP condition.

### Step 2: Confirm the full local suite now passes

Run each of these and record the actual result:

`npm run typecheck`, `npm test`, `npm run build`, `npm run build:firefox`,
then `cd native/hsyncd && go test ./... && go vet ./... && cd ../..`.

**Verify**: all exit 0. `npm test` should report all tests passing (expect
roughly 43 across 8 files; report the real number you observe). If any command
fails, STOP and report the exact output — do not fix source code in this plan.

### Step 3: Add the `engines` field

In `package.json`, add an `engines` field directly after the `"private": true`
line, pinning a floor that matches the toolchain this project actually uses:

```json
  "engines": {
    "node": ">=22"
  },
```

**Verify**: `node -e "JSON.parse(require('fs').readFileSync('package.json'))" `
→ exit 0 (file is still valid JSON). Then `npm run typecheck` → exit 0.

### Step 4: Create the CI workflow

Create `.github/workflows/ci.yml` with two independent jobs so a failure in one
half does not mask the other:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  extension:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        node-version: ['22', '24']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
      - run: npm run build:firefox
      - name: Verify both builds produced output
        run: test -d .output/chrome-mv3 && test -d .output/firefox-mv3

  native:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.24'
          cache-dependency-path: native/hsyncd/go.sum
      - run: go test ./...
        working-directory: native/hsyncd
      - run: go vet ./...
        working-directory: native/hsyncd
      - run: go build -o /tmp/hsyncd ./cmd/hsyncd
        working-directory: native/hsyncd

  schema:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Protocol schema is valid JSON
        run: jq empty native/protocol/v1.schema.json
```

**Verify**: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))"`
→ exit 0 (the YAML parses). If `python3`/`yaml` is unavailable, use
`npx --yes js-yaml .github/workflows/ci.yml > /dev/null` → exit 0.

### Step 5: Confirm nothing else changed

**Verify**: `git status --porcelain` → exactly two entries, `package.json`
(modified) and `.github/workflows/ci.yml` (new). Nothing else.

## Test plan

This plan adds no application tests — it makes the existing ones runnable and
enforced. Verification is that every command in the table above exits 0 locally,
and that the workflow file parses as valid YAML.

Do not add new test files in this plan.

## Done criteria

ALL must hold:

- [ ] `npm ci` exits 0 and `node_modules/@rolldown/` contains a platform binding
- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with all tests passing
- [ ] `npm run build` and `npm run build:firefox` both exit 0
- [ ] `.output/chrome-mv3/` and `.output/firefox-mv3/` both exist
- [ ] `cd native/hsyncd && go test ./... && go vet ./...` exits 0
- [ ] `.github/workflows/ci.yml` exists and parses as YAML
- [ ] `package.json` contains an `engines.node` field and is valid JSON
- [ ] `git status --porcelain` shows only the two in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- `npm ci` fails, or `@rolldown` bindings are still missing afterward. The
  premise of this plan is that `npm ci` repairs the install; if it does not,
  the root cause is different and needs re-diagnosis.
- Any of `npm test`, `npm run build`, `npm run build:firefox`, `go test`, or
  `go vet` fails. **Do not fix the failure** — it is a pre-existing defect that
  other plans address, and this plan must not silently absorb source changes.
  Report the exact output.
- `git status` shows modifications to files outside the in-scope list.
- The repository already contains a `.github/workflows/` directory (the drift
  check should have caught this).

## Maintenance notes

- Once this is green, `HANDOFF.md`'s manual checklist should be deleted and
  replaced with a pointer to this workflow, so there is one source of truth.
  That edit is deliberately out of scope here because `HANDOFF.md` has
  uncommitted local changes.
- The `GOCACHE`/`GOMODCACHE` prefixes in the old checklist are environment
  specific and intentionally absent from CI.
- Coverage reporting and lint were both considered and deferred: coverage is
  not useful until the untested router/service layer is covered, and a
  formatter's first run would rewrite files currently under human review.
- A reviewer should check that the two jobs are genuinely independent — the
  point is that a Go regression cannot hide behind a passing TypeScript job.
