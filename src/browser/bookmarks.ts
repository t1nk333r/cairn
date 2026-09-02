import type { BookmarkDocument, BookmarkNode, BookmarkTreeNodeLike } from '../core/bookmarks';
import { captureBookmarks } from '../core/bookmarks';
import type { DeviceObservation } from '../core/inventory';

const BOOKMARKS_KEY = 'latestBookmarks';
const BOOKMARKS_BASELINE_KEY = 'bookmarksBaseline';

/** The subset of `browser.bookmarks` this module uses, injectable for tests. */
export interface BookmarksApi {
  getTree(): Promise<BookmarkTreeNodeLike[]>;
  create(input: {
    parentId?: string;
    title?: string;
    url?: string;
  }): Promise<{ id: string }>;
}

export interface RestoreSummary {
  folderTitle: string;
  createdFolders: number;
  createdBookmarks: number;
  /** Entries the browser refused, e.g. bookmarklets or unsupported schemes. */
  skipped: number;
}

export async function captureLocalBookmarks(input: {
  api: BookmarksApi;
  device: DeviceObservation;
  now?: () => Date;
}): Promise<BookmarkDocument> {
  const tree = await input.api.getTree();
  return captureBookmarks({
    tree,
    device: input.device,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

// Chromium's "Other bookmarks" is id '2'; Firefox's unfiled folder is
// 'unfiled_____'. Fall back to the last top-level folder, which is that folder
// in both browsers today, rather than guessing at the super-root — creating
// directly under the root is rejected.
function pickRestoreParent(tree: BookmarkTreeNodeLike[]): string {
  const roots =
    tree.length === 1 && tree[0]?.url === undefined ? (tree[0]?.children ?? []) : tree;
  const preferred = roots.find((root) => root.id === '2' || root.id === 'unfiled_____');
  const fallback = roots[roots.length - 1];
  const chosen = preferred ?? fallback;
  if (!chosen) throw new Error('The browser reported no bookmark folders to restore into.');
  return chosen.id;
}

function restoreFolderTitle(document: BookmarkDocument, at: Date): string {
  const stamp = at.toISOString().slice(0, 16).replace('T', ' ');
  return `Restored ${stamp} — ${document.device.label}`;
}

/**
 * Recreates a backup inside a new, clearly labelled folder.
 *
 * Restore is deliberately **additive**: nothing existing is moved, renamed, or
 * deleted, so a restore can never destroy bookmarks the user still wanted and
 * needs no undo story. Removing the new folder afterwards is a single action
 * the user already knows how to perform.
 */
export async function restoreBookmarks(input: {
  api: BookmarksApi;
  document: BookmarkDocument;
  now?: () => Date;
}): Promise<RestoreSummary> {
  const now = input.now ?? (() => new Date());
  const parentId = pickRestoreParent(await input.api.getTree());
  const folderTitle = restoreFolderTitle(input.document, now());
  const root = await input.api.create({ parentId, title: folderTitle });

  const summary: RestoreSummary = {
    folderTitle,
    createdFolders: 0,
    createdBookmarks: 0,
    skipped: 0,
  };

  const walk = async (nodes: BookmarkNode[], into: string): Promise<void> => {
    for (const node of nodes) {
      if (node.children !== undefined) {
        try {
          const folder = await input.api.create({ parentId: into, title: node.title });
          summary.createdFolders += 1;
          await walk(node.children, folder.id);
        } catch {
          // A folder the browser refuses takes its subtree with it; count the
          // whole branch as skipped rather than aborting the restore.
          summary.skipped += 1;
        }
        continue;
      }
      try {
        await input.api.create({
          parentId: into,
          title: node.title,
          ...(node.url !== undefined ? { url: node.url } : {}),
        });
        summary.createdBookmarks += 1;
      } catch {
        summary.skipped += 1;
      }
    }
  };

  await walk(input.document.roots, root.id);
  return summary;
}

export async function saveBookmarks(document: BookmarkDocument): Promise<void> {
  await browser.storage.local.set({ [BOOKMARKS_KEY]: document });
}

export async function loadBookmarks(): Promise<BookmarkDocument | null> {
  const stored = await browser.storage.local.get(BOOKMARKS_KEY);
  const value = stored[BOOKMARKS_KEY];
  return isStoredDocument(value) ? value : null;
}

export async function saveBookmarksBaseline(document: BookmarkDocument): Promise<void> {
  await browser.storage.local.set({ [BOOKMARKS_BASELINE_KEY]: document });
}

export async function loadBookmarksBaseline(): Promise<BookmarkDocument | null> {
  const stored = await browser.storage.local.get(BOOKMARKS_BASELINE_KEY);
  const value = stored[BOOKMARKS_BASELINE_KEY];
  return isStoredDocument(value) ? value : null;
}

function isStoredDocument(value: unknown): value is BookmarkDocument {
  // Storage round-trips structured clones, so a cheap shape check is enough;
  // anything arriving over the network goes through `parseBookmarkJson`.
  return (
    !!value &&
    typeof value === 'object' &&
    (value as BookmarkDocument).schemaVersion === 1 &&
    Array.isArray((value as BookmarkDocument).roots)
  );
}
