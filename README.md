# hsync

`hsync` is a FOSS browser-extension inventory synchronizer for Chromium-family
browsers (including Helium) and Firefox.

## Current status

Milestone 1 is underway. The repository currently includes:

- Chromium/Helium and Firefox Manifest V3 builds from one WXT codebase;
- normalized extension inventory capture through the management API;
- automatic recapture on install, uninstall, enable, and disable events;
- local inventory persistence with hsync self-exclusion;
- a full-page inventory control center, opened in its own tab from the
  toolbar icon;
- validated local JSON export/import using a separate comparison baseline;
- a comparison view for missing, local-only, version, and state differences;
- a WebDAV backend with connection testing, Pull, and protected Upload;
- an S3-compatible backend with tested AWS Signature V4, path-style and
  virtual-host addressing, session credentials, Pull, and protected Upload;
- a Gitea repository backend with token authentication, branch validation,
  Pull, and SHA-protected commits;
- a GitHub and GitHub Enterprise repository backend using ordinary commits and
  blob-SHA conflict protection;
- runtime endpoint permission requests, HTTPS enforcement, and ETag conflict
  detection;
- deterministic serialization and inventory-diff primitives;
- unit tests for capture, filtering, ordering, comparison, import safety, and
  WebDAV behavior.

Encryption, automatic cross-device merge, and guided restore are the next
slices. Browser-only
repository, WebDAV, and S3 backends currently expose explicit Pull and Upload
operations;
automatic merge is not presented as complete yet.

It records which extensions are installed, compares devices, and guides the
user through restoring missing extensions. Inventories can be stored in:

- a Git repository
- Gitea
- WebDAV
- S3-compatible object storage

The project intentionally does not claim to silently install extensions.
Browser security APIs do not allow an extension to silently install arbitrary
ordinary extensions.

Guided restore is **not implemented yet**. Today hsync captures, compares, and
syncs inventories; the Compare view links out to an extension's store or
project page, but nothing detects installation or reconciles enabled/disabled
state afterwards. See [PLAN.md](PLAN.md) Milestone 4 for the intended design.

See [PLAN.md](PLAN.md) for the architecture and delivery sequence.
The product structure intentionally adapts proven ideas from the MIT-licensed
[Bookmarkora](https://github.com/gygy/Bookmarkora); see
[BOOKMARKORA_ADAPTATION.md](BOOKMARKORA_ADAPTATION.md) for the mapping and the
boundaries of reuse.

An optional native companion for arbitrary-Git support, informed by the
MIT-licensed [helium-sync-git](https://github.com/mdeloughry/helium-sync-git),
was built and then removed on 2026-08-31 in favor of staying browser-only. See
[HELIUM_SYNC_GIT_ADAPTATION.md](HELIUM_SYNC_GIT_ADAPTATION.md) for why.

## Development

Requires a current Node.js release and npm.

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run build:firefox
```

Use `npm ci`, not `npm install` — a partial install can leave the optional
platform binary for the bundler missing, which fails every build and test with
an unrelated-looking error.

Unpacked production builds are generated at:

- `.output/chrome-mv3/`
- `.output/firefox-mv3/`

See [docs/S3_SETUP.md](docs/S3_SETUP.md) for endpoint, addressing, credentials,
CORS, and conflict requirements.

See [docs/GITEA_SETUP.md](docs/GITEA_SETUP.md) for repository, branch, token,
and conflict-protection guidance.

See [docs/GITHUB_SETUP.md](docs/GITHUB_SETUP.md) for GitHub, GitHub Enterprise,
fine-grained token, and branch setup.

For live development:

```bash
npm run dev
npm run dev:firefox
```

## License

hsync is licensed under the GNU Affero General Public License, version 3 or
later (`AGPL-3.0-or-later`). The full text is in [`LICENSE`](LICENSE).

AGPL was chosen because hsync is aimed at self-hosting: it keeps the source
available to anyone who runs a modified version as a network service.

Any reused Bookmarkora code retains its MIT copyright and license notice; see
`THIRD_PARTY_NOTICES.md`.
