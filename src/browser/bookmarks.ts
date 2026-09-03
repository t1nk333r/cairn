import type {
  BookmarkCounts,
  BookmarkDocument,
  BookmarkNode,
  BookmarkPath,
  BookmarkTreeNodeLike,
} from '../core/bookmarks';
import {
  captureBookmarks,
  countBookmarks,
  normalizeBookmarkNode,
  selectBookmarkNodes,
} from '../core/bookmarks';
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

// `getTree` returns a single unnamed super-root; the real top-level folders are
// its children. Everything here addresses those, never the super-root itself,
// which is not a folder a user recognizes and which the browser refuses as a
// create target.
function topLevelFolders(tree: BookmarkTreeNodeLike[]): BookmarkTreeNodeLike[] {
  return tree.length === 1 && tree[0]?.url === undefined ? (tree[0]?.children ?? []) : tree;
}

export interface BookmarkRootSummary {
  /** Live browser-local id: '1'/'2' on Chromium, 'toolbar_____'/'unfiled_____' on Firefox. */
  id: string;
  title: string;
  counts: BookmarkCounts;
}

/**
 * Summarizes the browser's top-level folders so the user can choose which ones
 * to back up. Ids are read from the browser rather than assumed: they differ
 * between Chromium and Firefox, and Firefox's set grows with the profile.
 */
export async function listBookmarkRoots(api: BookmarksApi): Promise<BookmarkRootSummary[]> {
  return topLevelFolders(await api.getTree()).map((root) => ({
    id: root.id,
    title: (root.title ?? '').trim(),
    // Counts describe the contents; the root folder itself is the label.
    counts: countBookmarks((root.children ?? []).map(normalizeBookmarkNode)),
  }));
}

export async function captureLocalBookmarks(input: {
  api: BookmarksApi;
  device: DeviceObservation;
  /** Live root ids to include. Omitted or empty means every root. */
  includeRootIds?: readonly string[] | undefined;
  now?: () => Date;
}): Promise<BookmarkDocument> {
  const tree = await input.api.getTree();
  const now = input.now !== undefined ? { now: input.now } : {};
  const include = input.includeRootIds;
  if (include === undefined || include.length === 0) {
    return captureBookmarks({ tree, device: input.device, ...now });
  }

  const wanted = new Set(include);
  const kept = topLevelFolders(tree).filter((root) => wanted.has(root.id));
  if (kept.length === 0) {
    // Excluding a root is how a private folder stays out of a shared
    // repository, so a stale or misspelled id must fail loudly instead of
    // writing an empty backup over a good one.
    throw new Error(
      `None of the selected bookmark folders exist in this browser: ${include.join(', ')}.`,
    );
  }

  // Re-wrap in a super-root: `captureBookmarks` unwraps a lone folder-shaped
  // entry, which would promote a single kept root's children to top level.
  return captureBookmarks({
    tree: [{ id: 'cairn-selection', title: '', children: kept }],
    device: input.device,
    ...now,
  });
}

// Chromium's "Other bookmarks" is id '2'; Firefox's unfiled folder is
// 'unfiled_____'. Fall back to the last top-level folder, which is that folder
// in both browsers today.
function pickRestoreParent(tree: BookmarkTreeNodeLike[]): string {
  const roots = topLevelFolders(tree);
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
  /** Node paths to recreate. Omitted means the whole document. */
  select?: readonly BookmarkPath[] | undefined;
  now?: () => Date;
}): Promise<RestoreSummary> {
  const now = input.now ?? (() => new Date());
  // Resolve the selection before creating anything, so a bad path leaves no
  // empty dated folder behind.
  const roots =
    input.select === undefined
      ? input.document.roots
      : selectBookmarkNodes(input.document.roots, input.select);
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

  await walk(roots, root.id);
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
