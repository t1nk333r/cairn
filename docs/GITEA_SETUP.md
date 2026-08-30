# Gitea setup

hsync can store its extension inventory as a JSON file in a Gitea repository.
It works with a hosted Gitea service or a self-hosted instance, including an
instance installed below a URL subpath.

## Required values

- **Instance URL:** the public Gitea URL, such as `https://git.example.com` or
  `https://example.com/gitea`. Do not include `/api/v1`.
- **Access token:** a Gitea personal access token that can read and write the
  selected repository contents.
- **Owner and repository:** the repository namespace and name.
- **Branch:** an existing branch, normally `main`.
- **File path:** where hsync should keep the inventory, such as
  `sync/extensions.json`.

Use HTTPS for remote servers. Plain HTTP is accepted only for localhost so a
local Gitea installation can be tested safely.

## How synchronization is protected

Pull records the current Gitea blob SHA. Upload includes that SHA when updating
the file. If another device changed the file first, Gitea rejects the stale
write and hsync asks you to pull and compare instead of silently overwriting it.

The first upload creates the file. Later uploads create ordinary repository
commits, so the inventory also has Gitea's normal revision history.

The access token is kept separately from the visible connection settings in
browser-local extension storage. It is sent only to the configured Gitea
origin.
