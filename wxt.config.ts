import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  targetBrowsers: ['chrome', 'firefox'],
  manifest: ({ browser }) => ({
    name: 'Cairn',
    description: 'Sync your browser extension inventory using storage you control.',
    version: '0.1.0',
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
