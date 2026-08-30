# hsyncd

`hsyncd` is the optional native companion for hsync. It will provide arbitrary
Git HTTPS and SSH transport, OS-keyring credentials, and safe concurrent Git
updates for users who choose that backend.

The companion supports authenticated HTTPS Git remotes for connection tests,
inventory reads, optimistic revision checks, commits, and pushes. It invokes
the system Git executable directly without a shell, disables interactive
prompts and ambient Git configuration, validates branch/file inputs, and works
only in private temporary checkouts.

HTTPS credentials are stored by origin in macOS Keychain, Linux Secret Service,
or Windows Credential Manager. Tokens never appear in Git command arguments,
saved extension configuration, native responses, or logs. Authenticated Git
requests refuse redirects. Credential-bearing URLs remain rejected.

SSH authentication is not implemented yet, and the companion does not advertise
the combined sync command.
The extension requests its optional Native Messaging permission only when the
user selects **Detect companion**, then validates the correlated hello response
and displays the companion version and advertised capabilities.
When Git transport capabilities are present, the control center exposes the
remote URL, branch, and inventory path plus connection, Pull, and Commit actions.
It retains the last-read revision locally and supplies it on the next write.
The token field is cleared immediately after the keyring confirms storage.

## Development

```bash
cd native/hsyncd
go test ./...
go build ./cmd/hsyncd
```

The host reads and writes Native Messaging frames on standard input and output.
All diagnostics go to standard error. Frames larger than 1 MiB are rejected.
The inventory itself is limited to 768 KiB so its Base64-encoded message stays
under that limit. Repository symlinks are rejected anywhere along its path.

Registration templates are separate for Chromium-family browsers and Firefox
because their allow-list fields differ. Installers must replace the binary path
and Chromium extension ID explicitly; wildcards are never used.
