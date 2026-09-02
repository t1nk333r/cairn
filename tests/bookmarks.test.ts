import { describe, expect, it } from 'vitest';
import {
  captureBookmarks,
  countBookmarks,
  isBookmarkDocument,
  normalizeBookmarkTree,
  parseBookmarkJson,
  serializeBookmarks,
  type BookmarkTreeNodeLike,
} from '../src/core/bookmarks';
import { InventoryFormatError } from '../src/core/inventory';
import { restoreBookmarks, type BookmarksApi } from '../src/browser/bookmarks';
import { bookmarksSibling } from '../src/browser/bookmarks-sync';

const device = {
  id: 'laptop',
  label: 'Laptop',
  browserFamily: 'chromium' as const,
  browserName: 'Chromium',
};

// A Chromium-shaped tree: one unnamed super-root wrapping the real folders.
const tree = (): BookmarkTreeNodeLike[] => [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        dateAdded: 1_700_000_000_000,
        children: [
          { id: '5', title: 'Example', url: 'https://example.org/', dateAdded: 1_700_000_100_000 },
          {
            id: '6',
            title: 'Work',
            children: [{ id: '7', title: 'Docs', url: 'https://docs.example.org/' }],
          },
          { id: '8', title: 'Empty folder', children: [] },
        ],
      },
      { id: '2', title: 'Other bookmarks', children: [] },
    ],
  },
];

describe('normalizeBookmarkTree', () => {
  it('unwraps the super-root and keeps the real top-level folders', () => {
    const roots = normalizeBookmarkTree(tree());
    expect(roots.map((root) => root.title)).toEqual(['Bookmarks bar', 'Other bookmarks']);
  });

  it('drops browser-local ids and sibling indexes', () => {
    // Check the tree itself; the document's `device` legitimately has an id.
    const roots = JSON.stringify(normalizeBookmarkTree(tree()));
    expect(roots).not.toContain('"id"');
    expect(roots).not.toContain('"index"');
    expect(roots).not.toContain('parentId');
  });

  it('preserves order, which is what the bookmarks bar shows', () => {
    const bar = normalizeBookmarkTree(tree())[0];
    expect(bar?.children?.map((child) => child.title)).toEqual([
      'Example',
      'Work',
      'Empty folder',
    ]);
  });

  it('distinguishes folders from bookmarks, including empty folders', () => {
    const bar = normalizeBookmarkTree(tree())[0];
    const [example, work, empty] = bar?.children ?? [];
    expect(example?.url).toBe('https://example.org/');
    expect(example?.children).toBeUndefined();
    expect(work?.children).toHaveLength(1);
    expect(empty?.children).toEqual([]);
  });

  it('converts dateAdded to ISO and omits it when absent', () => {
    const bar = normalizeBookmarkTree(tree())[0];
    expect(bar?.children?.[0]?.addedAt).toBe(new Date(1_700_000_100_000).toISOString());
    expect('addedAt' in (bar?.children?.[1]?.children?.[0] ?? {})).toBe(false);
  });

  it('handles a Firefox-shaped tree with several roots and no wrapper', () => {
    const roots = normalizeBookmarkTree([
      { id: 'toolbar_____', title: 'Bookmarks Toolbar', children: [] },
      { id: 'unfiled_____', title: 'Other Bookmarks', children: [] },
    ]);
    expect(roots).toHaveLength(2);
  });
});

describe('countBookmarks', () => {
  it('counts bookmarks and folders separately at every depth', () => {
    expect(countBookmarks(normalizeBookmarkTree(tree()))).toEqual({
      bookmarks: 2,
      folders: 4,
    });
  });
});

describe('bookmark document round trip', () => {
  it('parses what it serializes', () => {
    const document = captureBookmarks({ tree: tree(), device });
    expect(parseBookmarkJson(serializeBookmarks(document))).toEqual(document);
  });

  it('ends with exactly one newline', () => {
    const text = serializeBookmarks(captureBookmarks({ tree: tree(), device }));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  it('rejects malformed JSON, a wrong schema version, and a wrong shape', () => {
    expect(() => parseBookmarkJson('{')).toThrow(InventoryFormatError);
    const doc = captureBookmarks({ tree: tree(), device });
    expect(() =>
      parseBookmarkJson(JSON.stringify({ ...doc, schemaVersion: 99 })),
    ).toThrow(/unsupported schema version 99/);
    expect(() => parseBookmarkJson('{"schemaVersion":1}')).toThrow(InventoryFormatError);
  });

  it('rejects a node whose children are not bookmark nodes', () => {
    const doc = captureBookmarks({ tree: tree(), device });
    expect(
      isBookmarkDocument({ ...doc, roots: [{ title: 'Bad', children: ['nope'] }] }),
    ).toBe(false);
  });

  it('keeps a bookmarklet URL verbatim rather than dropping it', () => {
    const roots = normalizeBookmarkTree([
      { id: '0', title: '', children: [{ id: '1', title: 'Bookmarklet', url: 'javascript:void 0' }] },
    ]);
    // Fidelity is right for a backup; the UI must never render it as a link.
    expect(roots[0]?.url).toBe('javascript:void 0');
  });
});

describe('restoreBookmarks', () => {
  const fakeApi = (options: { rejectUrls?: RegExp } = {}) => {
    const created: Array<{ id: string; parentId?: string; title?: string; url?: string }> = [];
    let next = 100;
    const api: BookmarksApi = {
      getTree: async () => tree(),
      create: async (input) => {
        if (options.rejectUrls && input.url && options.rejectUrls.test(input.url)) {
          throw new Error('unsupported scheme');
        }
        const id = String(next++);
        created.push({ id, ...input });
        return { id };
      },
    };
    return { api, created };
  };

  const document = () => captureBookmarks({ tree: tree(), device });
  const at = new Date('2026-09-02T15:40:00.000Z');

  it('creates one labelled folder and never deletes anything', async () => {
    const { api, created } = fakeApi();
    const summary = await restoreBookmarks({ api, document: document(), now: () => at });

    expect(summary.folderTitle).toBe('Restored 2026-09-02 15:40 — Laptop');
    expect(created[0]).toMatchObject({ parentId: '2', title: summary.folderTitle });
    // The fake exposes no delete or move; restore must not need one.
    expect(Object.keys(api)).toEqual(['getTree', 'create']);
  });

  it('recreates the whole tree under that folder', async () => {
    const { api, created } = fakeApi();
    const summary = await restoreBookmarks({ api, document: document(), now: () => at });

    expect(summary.createdBookmarks).toBe(2);
    // Both roots, plus Work and Empty folder, plus the restore folder itself.
    expect(summary.createdFolders).toBe(4);
    expect(summary.skipped).toBe(0);
    expect(created.some((entry) => entry.url === 'https://docs.example.org/')).toBe(true);
  });

  it('restores into Other bookmarks, not the bookmarks bar', async () => {
    const { api, created } = fakeApi();
    await restoreBookmarks({ api, document: document(), now: () => at });
    expect(created[0]?.parentId).toBe('2');
  });

  it('counts entries the browser refuses instead of aborting', async () => {
    const { api } = fakeApi({ rejectUrls: /^javascript:/ });
    const doc = captureBookmarks({
      tree: [
        {
          id: '0',
          title: '',
          children: [
            {
              id: '1',
              title: 'Bar',
              children: [
                { id: '2', title: 'Fine', url: 'https://example.org/' },
                { id: '3', title: 'Bookmarklet', url: 'javascript:void 0' },
              ],
            },
          ],
        },
      ],
      device,
    });

    const summary = await restoreBookmarks({ api, document: doc, now: () => at });
    expect(summary.createdBookmarks).toBe(1);
    expect(summary.skipped).toBe(1);
  });
});

describe('bookmarksSibling', () => {
  it('derives a sibling name beside the inventory document', () => {
    expect(bookmarksSibling('cairn.json')).toBe('cairn-bookmarks.json');
    expect(bookmarksSibling('devices/cairn.json')).toBe('devices/cairn-bookmarks.json');
    expect(bookmarksSibling('a/b/c/inventory.json')).toBe('a/b/c/inventory-bookmarks.json');
  });

  it('handles names with no extension and with several dots', () => {
    expect(bookmarksSibling('inventory')).toBe('inventory-bookmarks');
    expect(bookmarksSibling('my.inventory.json')).toBe('my.inventory-bookmarks.json');
  });

  it('leaves a dotfile intact rather than splitting on its leading dot', () => {
    expect(bookmarksSibling('.cairn')).toBe('.cairn-bookmarks');
  });

  it('never escapes the configured directory', () => {
    for (const input of ['cairn.json', 'devices/cairn.json', '.cairn']) {
      expect(bookmarksSibling(input)).not.toContain('..');
    }
  });
});
