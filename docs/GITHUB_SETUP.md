# GitHub repository setup

Cairn can store its inventory in GitHub or GitHub Enterprise through the
repository Contents API. Each upload creates an ordinary Git commit without
requiring a native helper.

## Required values

- **API URL:** use `https://api.github.com` for GitHub.com. For GitHub
  Enterprise, use the instance's REST API base URL.
- **Owner and repository:** select the repository that will hold the inventory.
- **Branch:** use an existing branch, normally `main`.
- **File path:** choose a path such as `sync/extensions.json`.
- **Access token:** use a fine-grained personal access token restricted to the
  selected repository with **Contents: Read and write** permission.

The token is stored separately from visible connection settings in local
extension storage and is sent only to the configured API origin.

## Conflict protection

Pull records the file's current Git blob SHA. The next commit supplies that SHA
as its expected version. If the file changed on another device, GitHub rejects
the stale update and Cairn asks you to pull and compare first.

GitHub branch protection still applies. A branch that forbids direct commits
cannot be used until its repository rules permit this token to write there.

Arbitrary Git remotes, SSH keys, and SSH agents are intentionally outside the
browser API backend. Those will use the optional `the native companion` native companion.
