# hsync

`hsync` is a FOSS browser-extension inventory synchronizer for Chromium-family
browsers (including Helium) and Firefox.

It records which extensions are installed, compares devices, and guides the
user through restoring missing extensions. Inventories can be stored in:

- a Git repository
- Gitea
- WebDAV
- S3-compatible object storage

The project intentionally does not claim to silently install extensions.
Browser security APIs do not allow an extension to silently install arbitrary
ordinary extensions. Restore opens trusted store or project pages and then
reconciles enabled/disabled state after the user completes installation.

See [PLAN.md](PLAN.md) for the architecture and delivery sequence.
The product structure intentionally adapts proven ideas from the MIT-licensed
[Bookmarkora](https://github.com/gygy/Bookmarkora); see
[BOOKMARKORA_ADAPTATION.md](BOOKMARKORA_ADAPTATION.md) for the mapping and the
boundaries of reuse.

## License

Planned: AGPL-3.0-or-later for original hsync code. Any reused Bookmarkora code
will retain its MIT copyright and license notice. License files and a
third-party notice will be added with the initial implementation scaffold.
