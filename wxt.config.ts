import { defineConfig } from 'wxt';

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
              id: 'cairn@t1nk333r.dev',
              strict_min_version: '128.0',
              data_collection_permissions: {
                required: ['none'],
              },
            },
          }
        : undefined,
  }),
});
