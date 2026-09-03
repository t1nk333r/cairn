import { createRequire } from 'node:module';
import { defineConfig } from 'wxt';

// The add-on id, minimum Firefox, and update-manifest URL are shared with
// scripts/update-manifest.mjs, which cannot import TypeScript. package.json is
// the one file both can read.
const { cairn } = createRequire(import.meta.url)('./package.json');

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  zip: {
    // The Firefox sources archive goes to AMO reviewers. Ship what is needed
    // to reproduce the build; leave out maintainer notes that are not part of
    // the product and are not tracked in the repository anyway.
    excludeSources: ['HANDOFF.md'],
  },
  manifestVersion: 3,
  targetBrowsers: ['chrome', 'firefox'],
  manifest: ({ browser }) => ({
    name: 'Cairn',
    // Chrome Web Store truncates at 132 characters; keep it inside that.
    description:
      'Back up your extensions and bookmarks to storage you control: Git, Gitea, WebDAV, or S3. No account, no server of ours.',
    // version is intentionally omitted: WXT derives it from package.json, so
    // `npm version` is the single bump. A mismatch would fail the release
    // workflow's tag guard.
    permissions: ['management', 'storage', 'bookmarks'],
    action: {
      default_title: 'Cairn',
    },
    optional_host_permissions: [
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    browser_specific_settings:
      browser === 'firefox'
        ? {
            gecko: {
              id: cairn.geckoId,
              strict_min_version: cairn.strictMinVersion,
              // Without this, Firefox never checks for a new version and every
              // update is a manual reinstall. It must point at HTTPS-hosted
              // JSON listing each release and its signed .xpi.
              update_url: cairn.updateManifestUrl,
              data_collection_permissions: {
                required: ['none'],
              },
            },
          }
        : undefined,
  }),
});
