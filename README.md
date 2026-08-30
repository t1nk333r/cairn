# hsync

`hsync` is a FOSS browser-extension inventory synchronizer for Chromium-family
browsers (including Helium) and Firefox.

## Current status

Milestone 1 is underway. The repository currently includes:

- Chromium/Helium and Firefox Manifest V3 builds from one WXT codebase;
- normalized extension inventory capture through the management API;
- automatic recapture on install, uninstall, enable, and disable events;
- local inventory persistence with hsync self-exclusion;
- a compact popup and full-page inventory control center;
- validated local JSON export/import using a separate comparison baseline;
- a comparison view for missing, local-only, version, and state differences;
- deterministic serialization and inventory-diff primitives;
- unit tests for capture, filtering, ordering, comparison, and import safety.

Remote connections, encryption, cross-device merge, and guided restore are the
next slices; the current UI labels those areas rather than pretending they are
already connected.

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

True arbitrary-Git support is designed around an optional native companion,
informed by the MIT-licensed
[helium-sync-git](https://github.com/mdeloughry/helium-sync-git). Browser-only
backends remain available without installing that companion. See
[HELIUM_SYNC_GIT_ADAPTATION.md](HELIUM_SYNC_GIT_ADAPTATION.md).

## Development

Requires a current Node.js release and npm.

```bash
npm install
npm test
npm run typecheck
npm run build
npm run build:firefox
```

Unpacked production builds are generated at:

- `.output/chrome-mv3/`
- `.output/firefox-mv3/`

For live development:

```bash
npm run dev
npm run dev:firefox
```

## License

Planned: AGPL-3.0-or-later for original hsync code. Any reused Bookmarkora code
will retain its MIT copyright and license notice. License files and a
third-party notice will be added with the initial implementation scaffold.
