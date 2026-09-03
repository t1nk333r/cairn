import { describe, expect, it } from 'vitest';
import {
  captureBookmarks,
  listBookmarkPaths,
  selectBookmarkNodes,
  type BookmarkTreeNodeLike,
} from '../src/core/bookmarks';
import { InventoryFormatError } from '../src/core/inventory';
import {
  captureLocalBookmarks,
  listBookmarkRoots,
  restoreBookmarks,
  type BookmarksApi,
} from '../src/browser/bookmarks';

const device = {
  id: 'laptop',
  label: 'Laptop',
  browserFamily: 'chromium' as const,
  browserName: 'Chromium',
};

// A Chromium-shaped tree with a folder nested two levels deep, so selecting
// mid-tree has both an ancestor chain and a subtree to carry.
const tree = (): BookmarkTreeNodeLike[] => [
  {
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: 'Bookmarks bar',
        children: [
          { id: '5', title: 'Example', url: 'https://example.org/' },
          {
            id: '6',
            title: 'Work',
            children: [
              { id: '7', title: 'Docs', url: 'https://docs.example.org/' },
              {
                id: '9',
                title: 'Deep',
                children: [{ id: '10', title: 'Nested', url: 'https://nested.example.org/' }],
              },
            ],
          },
          { id: '8', title: 'Empty folder', children: [] },
        ],
      },
      {
        id: '2',
        title: 'Other bookmarks',
        children: [{ id: '11', title: 'Other link', url: 'https://other.example.org/' }],
      },
    ],
  },
];

const roots = () => captureBookmarks({ tree: tree(), device }).roots;

const fakeApi = (source: () => BookmarkTreeNodeLike[] = tree) => {
  const created: Array<{ id: string; parentId?: string; title?: string; url?: string }> = [];
  let next = 100;
  const api: BookmarksApi = {
    getTree: async () => source(),
    create: async (input) => {
      const id = String(next++);
      created.push({ id, ...input });
      return { id };
    },
  };
  return { api, created };
};

describe('listBookmarkPaths', () => {
  it('lists every node depth-first, parents before children', () => {
    const entries = listBookmarkPaths(roots());

    expect(entries.map((entry) => [entry.node.title, entry.path, entry.depth])).toEqual([
      ['Bookmarks bar', [0], 0],
      ['Example', [0, 0], 1],
      ['Work', [0, 1], 1],
      ['Docs', [0, 1, 0], 2],
      ['Deep', [0, 1, 1], 2],
      ['Nested', [0, 1, 1, 0], 3],
      ['Empty folder', [0, 2], 1],
      ['Other bookmarks', [1], 0],
      ['Other link', [1, 0], 1],
    ]);
  });

  it('returns paths that address the node they came from', () => {
    const document = roots();
    for (const entry of listBookmarkPaths(document)) {
      // Selecting one path prunes every sibling above it, so the node lands at
      // the all-zero path of the same length.
      const zeros = entry.path.map(() => 0).join();
      const selected = listBookmarkPaths(selectBookmarkNodes(document, [entry.path]));
      expect(selected.find((found) => found.path.join() === zeros)?.node).toEqual(entry.node);
    }
  });
});

describe('selectBookmarkNodes', () => {
  it('carries a mid-tree folder with its subtree and its parent chain', () => {
    const selected = selectBookmarkNodes(roots(), [[0, 1]]);

    expect(selected).toEqual([
      {
        title: 'Bookmarks bar',
        children: [
          {
            title: 'Work',
            children: [
              { title: 'Docs', url: 'https://docs.example.org/' },
              {
                title: 'Deep',
                children: [{ title: 'Nested', url: 'https://nested.example.org/' }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it('lets the folder win when a folder and its descendant are both selected', () => {
    const parentOnly = selectBookmarkNodes(roots(), [[0, 1]]);
    const withDescendant = selectBookmarkNodes(roots(), [
      [0, 1],
      [0, 1, 1, 0],
    ]);

    expect(withDescendant).toEqual(parentOnly);
  });

  it('keeps original sibling order regardless of the order paths arrive in', () => {
    const selected = selectBookmarkNodes(roots(), [
      [1],
      [0, 2],
      [0, 0],
    ]);

    expect(selected.map((node) => node.title)).toEqual(['Bookmarks bar', 'Other bookmarks']);
    expect(selected[0]?.children?.map((node) => node.title)).toEqual(['Example', 'Empty folder']);
  });

  it('keeps a selected folder empty when it is empty in the backup', () => {
    const selected = selectBookmarkNodes(roots(), [[0, 2]]);
    expect(selected[0]?.children).toEqual([{ title: 'Empty folder', children: [] }]);
  });

  it('selects nothing for an empty path list', () => {
    expect(selectBookmarkNodes(roots(), [])).toEqual([]);
  });

  it('rejects an empty path instead of silently selecting everything', () => {
    expect(() => selectBookmarkNodes(roots(), [[]])).toThrow(InventoryFormatError);
  });

  it('rejects a non-integer index', () => {
    expect(() => selectBookmarkNodes(roots(), [[0, 1.5]])).toThrow(InventoryFormatError);
  });

  it('rejects an index that does not exist', () => {
    expect(() => selectBookmarkNodes(roots(), [[5]])).toThrow(InventoryFormatError);
    expect(() => selectBookmarkNodes(roots(), [[0, -1]])).toThrow(InventoryFormatError);
    // A bookmark has no children to address.
    expect(() => selectBookmarkNodes(roots(), [[0, 0, 0]])).toThrow(InventoryFormatError);
  });
});

describe('listBookmarkRoots', () => {
  it('summarizes the top-level folders the browser reports, not the super-root', async () => {
    const { api } = fakeApi();
    expect(await listBookmarkRoots(api)).toEqual([
      { id: '1', title: 'Bookmarks bar', counts: { bookmarks: 3, folders: 3 } },
      { id: '2', title: 'Other bookmarks', counts: { bookmarks: 1, folders: 0 } },
    ]);
  });

  it('reads Firefox ids without a wrapper root', async () => {
    const { api } = fakeApi(() => [
      { id: 'toolbar_____', title: 'Bookmarks Toolbar', children: [] },
      {
        id: 'unfiled_____',
        title: 'Other Bookmarks',
        children: [{ id: 'x', title: 'Site', url: 'https://example.org/' }],
      },
    ]);

    expect((await listBookmarkRoots(api)).map((root) => root.id)).toEqual([
      'toolbar_____',
      'unfiled_____',
    ]);
  });

  it('counts a lone nested folder instead of unwrapping it', async () => {
    const { api } = fakeApi(() => [
      {
        id: '0',
        title: '',
        children: [
          {
            id: '1',
            title: 'Bookmarks bar',
            children: [
              {
                id: '2',
                title: 'Only folder',
                children: [{ id: '3', title: 'Site', url: 'https://example.org/' }],
              },
            ],
          },
        ],
      },
    ]);

    expect((await listBookmarkRoots(api))[0]?.counts).toEqual({ bookmarks: 1, folders: 1 });
  });
});

describe('captureLocalBookmarks with includeRootIds', () => {
  it('captures every root when the selection is omitted or empty', async () => {
    const { api } = fakeApi();
    const all = await captureLocalBookmarks({ api, device });
    const empty = await captureLocalBookmarks({ api, device, includeRootIds: [] });

    expect(all.roots.map((root) => root.title)).toEqual(['Bookmarks bar', 'Other bookmarks']);
    expect(empty.roots).toEqual(all.roots);
  });

  it('keeps only the named roots, so a private folder stays out of the backup', async () => {
    const { api } = fakeApi();
    const document = await captureLocalBookmarks({ api, device, includeRootIds: ['2'] });

    expect(document.roots.map((root) => root.title)).toEqual(['Other bookmarks']);
    expect(document.roots[0]?.children).toEqual([
      { title: 'Other link', url: 'https://other.example.org/' },
    ]);
  });

  it('follows the browser root order, not the order the ids were given', async () => {
    const { api } = fakeApi();
    const document = await captureLocalBookmarks({ api, device, includeRootIds: ['2', '1'] });

    expect(document.roots.map((root) => root.title)).toEqual([
      'Bookmarks bar',
      'Other bookmarks',
    ]);
  });

  it('throws when a selection matches nothing rather than writing an empty backup', async () => {
    const { api } = fakeApi();
    await expect(
      captureLocalBookmarks({ api, device, includeRootIds: ['toolbar_____'] }),
    ).rejects.toThrow(/toolbar_____/);
  });
});

describe('restoreBookmarks with a selection', () => {
  const at = new Date('2026-09-02T15:40:00.000Z');
  const document = () => captureBookmarks({ tree: tree(), device });

  it('recreates only the selected nodes, still additively', async () => {
    const { api, created } = fakeApi();
    const summary = await restoreBookmarks({
      api,
      document: document(),
      select: [[0, 1]],
      now: () => at,
    });

    expect(created.map((entry) => entry.title)).toEqual([
      summary.folderTitle,
      'Bookmarks bar',
      'Work',
      'Docs',
      'Deep',
      'Nested',
    ]);
    // Bookmarks bar, Work and Deep; the dated folder is not part of the backup.
    expect(summary.createdFolders).toBe(3);
    expect(summary.createdBookmarks).toBe(2);
    expect(summary.skipped).toBe(0);
    // Everything lands under the one new dated folder, and the fake exposes no
    // move or delete for restore to reach for.
    expect(created[0]).toMatchObject({ parentId: '2', title: summary.folderTitle });
    expect(created.slice(1).some((entry) => entry.parentId === '1')).toBe(false);
    expect(Object.keys(api)).toEqual(['getTree', 'create']);
  });

  it('leaves the pre-existing tree exactly as it was', async () => {
    const { api } = fakeApi();
    const before = JSON.stringify(await api.getTree());
    await restoreBookmarks({ api, document: document(), select: [[1]], now: () => at });

    expect(JSON.stringify(await api.getTree())).toBe(before);
  });

  it('restores the whole document when no selection is given', async () => {
    const { api, created } = fakeApi();
    const summary = await restoreBookmarks({ api, document: document(), now: () => at });

    expect(summary.createdBookmarks).toBe(4);
    expect(summary.createdFolders).toBe(5);
    expect(created).toHaveLength(10);
  });

  it('creates nothing at all when the selection does not address the document', async () => {
    const { api, created } = fakeApi();
    await expect(
      restoreBookmarks({ api, document: document(), select: [[9]], now: () => at }),
    ).rejects.toThrow(InventoryFormatError);
    expect(created).toEqual([]);
  });
});
