# hsyncd

`hsyncd` is the optional native companion for hsync. It will provide arbitrary
Git HTTPS and SSH transport, OS-keyring credentials, and safe concurrent Git
updates for users who choose that backend.

The companion supports public HTTPS Git remotes for connection tests,
inventory reads, optimistic revision checks, commits, and pushes. It invokes
the system Git executable directly without a shell, disables interactive
prompts and ambient Git configuration, validates branch/file inputs, and works
only in private temporary checkouts.

Token/keyring and SSH authentication are not implemented yet. Credential-bearing
URLs are rejected, and the companion does not advertise sync or secret commands.
The extension requests its optional Native Messaging permission only when the
user selects **Detect companion**, then validates the correlated hello response
and displays the companion version and advertised capabilities.

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
