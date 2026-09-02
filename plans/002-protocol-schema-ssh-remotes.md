# Plan 002: Make the native protocol schema describe the SSH remotes the host actually accepts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2f8fe62..HEAD -- native/protocol/ native/hsyncd/internal/gittransport/ native/hsyncd/internal/protocol/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but see the hard precondition below)
- **Category**: bug
- **Planned at**: commit `2f8fe62`, 2026-08-31

## HARD PRECONDITION — read before starting

This plan corrects a contradiction introduced by the SSH-transport work. At the
time of writing, that work was **uncommitted** in the maintainer's working
tree. A git worktree contains only committed files.

**Before doing anything, run:**

```bash
grep -n 'scpRemotePattern' native/hsyncd/internal/gittransport/git.go
```

If that returns **no match**, the SSH transport is not present in your checkout.
**STOP immediately and report** — the schema change in this plan would then
describe a transport that does not exist, which is worse than the current bug.

## Why this matters

`native/protocol/v1.schema.json` is described in the project's own architecture
map as "the shared protocol schema" — the contract between the TypeScript
extension and the Go native host. It constrains `remoteUrl` with
`"pattern": "^https://"` in all four payload definitions.

The SSH transport work makes both halves accept `ssh://…` and SCP-style
`git@host:owner/repo.git` remotes. The extension's own UI now advertises the
SCP form in its input placeholder. So the declared v1 contract now forbids
exactly what the shipped code does.

Nothing detects this. The only check applied to the schema anywhere in the
repository is `jq empty`, which verifies the file is parseable JSON and nothing
more. The schema is currently decorative: no test, build step, or runtime path
reads it. Anyone writing a second client, or reviewing the SSH change against
the stated contract, gets the wrong answer.

This plan fixes the contradiction and adds the first real enforcement, so the
two halves cannot silently drift again.

## Current state

`native/protocol/v1.schema.json` — the `remoteUrl` constraint appears **four
times**, at lines 11, 21, 33, and 43, each identical:

```json
        "remoteUrl": { "type": "string", "format": "uri", "pattern": "^https://" },
```

Those four sites belong to, in order: the connection-test payload, the
write-inventory payload, the set-secret payload, and the delete-secret payload.

`native/hsyncd/internal/gittransport/git.go:22-24` — the patterns the Go host
now uses to decide what a valid remote is:

```go
var branchPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)
var scpRemotePattern = regexp.MustCompile(`^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_~/.][^\s]*$`)
var sshUsernamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
```

`native/hsyncd/internal/gittransport/git.go:123-130` — the accept logic. The
SCP form is matched first and returned before URL parsing; otherwise the scheme
must be `https` or `ssh`:

```go
func normalizeRemote(raw string) (string, error) {
	if scpRemotePattern.MatchString(raw) && !strings.Contains(raw, "://") {
		return strings.TrimSuffix(raw, "/"), nil
	}
	remote, err := url.Parse(raw)
	if err != nil || (remote.Scheme != "https" && remote.Scheme != "ssh") || remote.Host == "" || remote.Path == "" {
		return "", &Error{Code: "invalid_config", Message: "Git remote must use HTTPS, ssh://, or safe SCP-like syntax."}
	}
```

`native/hsyncd/internal/protocol/message.go:5-19` — the protocol version and
the command constants. Note that `CommandSync`, `CommandGetStatus`, and
`CommandCancel` are **declared here** even though `host.go` does not handle
them (its `switch` falls through to `unsupported_command`). The schema's
command enum therefore matches these constants and is **not** in scope for this
plan — see "Out of scope".

```go
const Version = 1

type Command string

const (
	CommandHello          Command = "hello"
	CommandTestConnection Command = "testConnection"
	CommandReadInventory  Command = "readInventory"
	CommandWriteInventory Command = "writeInventory"
	CommandSync           Command = "sync"
	CommandGetStatus      Command = "getStatus"
	CommandCancel         Command = "cancel"
	CommandSetSecret      Command = "setSecret"
	CommandDeleteSecret   Command = "deleteSecret"
)
```

Go test conventions in this repo: plain standard-library `testing`, table-driven
where there are multiple cases, no assertion library. See
`native/hsyncd/internal/gittransport/git_test.go` for the established style —
`t.Fatalf` with a message naming the input, e.g.:

```go
	for _, remoteURL := range []string{ ... } {
		if _, err := NormalizeConfig(...); err == nil {
			t.Fatalf("expected %q to be rejected", remoteURL)
		}
	}
```

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Schema is valid JSON | `jq empty native/protocol/v1.schema.json` | exit 0, no output |
| Go tests | `cd native/hsyncd && go test ./...` | exit 0, all `ok` |
| Go vet | `cd native/hsyncd && go vet ./...` | exit 0, no output |
| Typecheck | `npm run typecheck` | exit 0 |

If `go test` fails with a cache permission error, prefix with
`GOCACHE=/tmp/hsync-go-cache GOMODCACHE=/tmp/hsync-go-mod-cache`.

## Scope

**In scope**:
- `native/protocol/v1.schema.json`
- `native/hsyncd/internal/protocol/schema_test.go` (create)

**Out of scope** (do NOT touch):
- `native/hsyncd/internal/gittransport/git.go` — the Go validation is the
  authority here and is already correct. The schema is what is wrong. Do not
  narrow the Go code to match the schema; that would remove working SSH support.
- The `command` enum in the schema. It currently matches the constants in
  `message.go`, including the three declared-but-unhandled ones. Whether to
  remove `sync`/`getStatus`/`cancel` is a maintainer decision about intent, not
  a mechanical fix — leave them alone.
- The `progress` value in the response `event` enum. The TypeScript client
  rejects any event other than `completed`/`failed`, so `progress` is currently
  unreachable — but that is the same open design question as above.
- `entrypoints/`, `src/`, and every other file under `native/hsyncd/`.

## Git workflow

- Branch: `advisor/002-protocol-schema-ssh-remotes`
- One commit; message: `fix: allow ssh and scp remotes in the native protocol schema`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Widen the four `remoteUrl` constraints

In `native/protocol/v1.schema.json`, replace **each** of the four occurrences of:

```json
        "remoteUrl": { "type": "string", "format": "uri", "pattern": "^https://" },
```

with a constraint that admits the three forms the Go host accepts. Use `anyOf`
so each accepted shape is named and self-documenting. Note the delete-secret
occurrence (line 43) has **no trailing comma** — preserve whatever punctuation
is already there at each site:

```json
        "remoteUrl": {
          "type": "string",
          "minLength": 1,
          "anyOf": [
            { "pattern": "^https://" },
            { "pattern": "^ssh://" },
            { "pattern": "^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.-]*:[A-Za-z0-9_~/.][^\\s]*$" }
          ]
        },
```

Note the `\\s` — inside a JSON string the backslash must be escaped so the
regex receives `\s`.

Remove the `"format": "uri"` keyword at all four sites: the SCP form
(`git@host:owner/repo.git`) is deliberately not a URI, so retaining it would
re-introduce the contradiction this plan exists to remove.

**Verify**: `jq empty native/protocol/v1.schema.json` → exit 0. Then confirm you
changed every site: `grep -c '"remoteUrl"' native/protocol/v1.schema.json` → `4`,
and `grep -c '\^https://' native/protocol/v1.schema.json` → `4` (one inside each
new `anyOf`, not as a standalone `pattern`). Also
`grep -c '"format": "uri"' native/protocol/v1.schema.json` → `0`.

### Step 2: Add a Go test that pins the schema to the implementation

Create `native/hsyncd/internal/protocol/schema_test.go`. It must read the real
schema file from disk and assert two things: that the command enum matches the
declared constants, and that the `remoteUrl` constraints accept the same remote
shapes the transport accepts. Use only the standard library — this repo has no
JSON-Schema dependency and this plan does not add one.

Locate the schema relative to the test file with
`filepath.Join("..", "..", "..", "protocol", "v1.schema.json")` (from
`native/hsyncd/internal/protocol/` that resolves to `native/protocol/`).
Confirm the path resolves before writing assertions — if it does not, fix the
path rather than skipping the test.

The test should:

1. Read and `json.Unmarshal` the schema into `map[string]any`.
2. Walk to `definitions.request.properties.command.enum`, collect it as a
   `[]string`, and assert it is exactly equal (as a set) to the nine `Command`
   constants declared in `message.go`. This is what stops the two from drifting.
3. Walk each of the four `remoteUrl` definitions, extract the `anyOf` patterns,
   compile them with `regexp.MustCompile`, and assert that each of these sample
   remotes matches at least one pattern:
   - `https://git.example.test/alice/sync.git`
   - `ssh://git@git.example.test:2222/alice/sync.git`
   - `git@git.example.test:alice/sync.git`
   And that this one matches none of them:
   - `ext::sh -c evil`

   Use the same sample values as `git_test.go` so the two test files agree.

**Verify**: `cd native/hsyncd && go test ./internal/protocol/ -run Schema -v`
→ exit 0, the new test(s) run and pass. Then
`cd native/hsyncd && go test ./...` → exit 0, everything still passes.

### Step 3: Confirm the whole native suite and the extension still pass

**Verify**: `cd native/hsyncd && go test ./... && go vet ./...` → both exit 0.
Then from the repo root, `npm run typecheck` → exit 0.

### Step 4: Confirm scope

**Verify**: `git status --porcelain` → exactly two entries:
`native/protocol/v1.schema.json` (modified) and
`native/hsyncd/internal/protocol/schema_test.go` (new).

## Test plan

New test file: `native/hsyncd/internal/protocol/schema_test.go`.

Cases to cover:
- **Command enum agreement** — schema enum set equals the `Command` constants.
  This is the regression guard: adding a constant without updating the schema
  (or vice versa) must fail.
- **Accepts HTTPS** — `https://git.example.test/alice/sync.git`.
- **Accepts ssh:// with a user and a port** — `ssh://git@git.example.test:2222/alice/sync.git`.
- **Accepts SCP form** — `git@git.example.test:alice/sync.git`.
- **Rejects a remote-helper string** — `ext::sh -c evil` matches no pattern.

Structural pattern to model: `native/hsyncd/internal/gittransport/git_test.go`,
specifically `TestNormalizeConfigAcceptsSSHRemotes` and
`TestNormalizeConfigRejectsUnsafeSSHRemotes` — same table-driven shape, same
`t.Fatalf("expected %q to ...", value)` message style.

Verification: `cd native/hsyncd && go test ./...` → all pass, including the new
schema tests.

## Done criteria

ALL must hold:

- [ ] `jq empty native/protocol/v1.schema.json` exits 0
- [ ] `grep -c '"format": "uri"' native/protocol/v1.schema.json` returns `0`
- [ ] All four `remoteUrl` definitions carry the three-pattern `anyOf`
- [ ] `native/hsyncd/internal/protocol/schema_test.go` exists and its tests pass
- [ ] The schema test fails if a `Command` constant is added without updating
      the schema (sanity-check this by temporarily adding one, observing the
      failure, then reverting — report that you did this)
- [ ] `cd native/hsyncd && go test ./...` exits 0
- [ ] `cd native/hsyncd && go vet ./...` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `git status --porcelain` shows only the two in-scope files

## STOP conditions

Stop and report back (do not improvise) if:

- `grep -n 'scpRemotePattern' native/hsyncd/internal/gittransport/git.go`
  returns nothing (see HARD PRECONDITION) — the SSH transport is absent.
- The four `remoteUrl` sites do not all read `"pattern": "^https://"` as shown
  in "Current state" — the schema has drifted since this plan was written.
- The schema-file path from the test does not resolve to
  `native/protocol/v1.schema.json`.
- You conclude the correct fix is to change `git.go` instead. It is not — the
  Go validation is the authority and the schema is the stale artifact. If you
  believe otherwise, stop and explain rather than editing it.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The schema is now load-bearing for the first time: a Go test reads it. Any
  future protocol change must update the schema in the same commit or CI fails.
- The TypeScript half still does **not** validate against this schema. Closing
  that side would need a JSON-Schema validator dependency (e.g. ajv) and is
  deliberately deferred — the Go-side pin covers the drift that actually
  occurred here.
- Two open design questions were deliberately left untouched and should be
  decided by the maintainer: whether `sync`/`getStatus`/`cancel` should remain
  declared while unhandled, and whether the `progress` event should be
  implemented (the TypeScript client currently rejects it) or removed.
- A reviewer should confirm the SCP regex in the schema is character-for-character
  the one in `git.go:23`, since two copies of a security-relevant pattern can
  now drift. A follow-up worth considering: generate one from the other.
