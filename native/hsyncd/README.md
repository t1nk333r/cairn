# hsyncd

`hsyncd` is the optional native companion for hsync. It will provide arbitrary
Git HTTPS and SSH transport, OS-keyring credentials, and safe concurrent Git
updates for users who choose that backend.

The current scaffold implements only protocol negotiation. It does not yet
clone repositories, store credentials, or advertise those capabilities.
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

Registration templates are separate for Chromium-family browsers and Firefox
because their allow-list fields differ. Installers must replace the binary path
and Chromium extension ID explicitly; wildcards are never used.
