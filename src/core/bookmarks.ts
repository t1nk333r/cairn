// Bookmark backup document: a normalized, device-independent snapshot of the
// browser's bookmark tree.
//
// Browser-local ids and sibling indexes are deliberately dropped. They differ
// on every device and change whenever anything is reordered, so keeping them
// would make every backup a full-file diff in the Git-backed backends. Order
// is preserved positionally instead, which is what actually matters for the
// bookmarks bar.
import type { DeviceObservation } from './inventory';
import { InventoryFormatError } from './inventory';

export const BOOKMARK_SCHEMA_VERSION = 1 as const;

export interface BookmarkNode {
  title: string;
  /** Absent for folders. Kept verbatim, including bookmarklets. */
  url?: string;
  /** ISO 8601. Absent when the browser does not report it. */
  addedAt?: string;
  /** Present for folders, including empty ones. */
  children?: BookmarkNode[];
}

export interface BookmarkDocument {
  schemaVersion: typeof BOOKMARK_SCHEMA_VERSION;
  generatedAt: string;
  device: DeviceObservation;
  /** The browser's top-level folders: bookmarks bar, other bookmarks, etc. */
  roots: BookmarkNode[];
}

/** The subset of `browser.bookmarks.BookmarkTreeNode` this module reads. */
export interface BookmarkTreeNodeLike {
  id: string;
  title?: string;
  url?: string;
  dateAdded?: number;
  children?: BookmarkTreeNodeLike[];
}

export interface BookmarkCounts {
  bookmarks: number;
  folders: number;
}

function normalizeNode(node: BookmarkTreeNodeLike): BookmarkNode {
  const title = (node.title ?? '').trim();
  const addedAt =
    typeof node.dateAdded === 'number' && Number.isFinite(node.dateAdded)
      ? new Date(node.dateAdded).toISOString()
      : undefined;

  // A node is a folder when it has no URL. Chromium reports `children` only on
  // folders; Firefox omits it for empty ones, so fall back to the URL test.
  if (node.url === undefined) {
    return {
      title,
      ...(addedAt !== undefined ? { addedAt } : {}),
      children: (node.children ?? []).map(normalizeNode),
    };
  }

  return {
    title,
    url: node.url,
    ...(addedAt !== undefined ? { addedAt } : {}),
  };
}

export function normalizeBookmarkTree(
  tree: BookmarkTreeNodeLike[],
): BookmarkNode[] {
  // `getTree` returns a single unnamed super-root whose children are the real
  // top-level folders; unwrap it so the document starts at something a user
  // recognizes.
  const roots = tree.length === 1 && tree[0]?.url === undefined
    ? (tree[0]?.children ?? [])
    : tree;
  return roots.map(normalizeNode);
}

export function captureBookmarks(input: {
  tree: BookmarkTreeNodeLike[];
  device: DeviceObservation;
  now?: () => Date;
}): BookmarkDocument {
  const now = input.now ?? (() => new Date());
  return {
    schemaVersion: BOOKMARK_SCHEMA_VERSION,
    generatedAt: now().toISOString(),
    device: input.device,
    roots: normalizeBookmarkTree(input.tree),
  };
}

export function countBookmarks(nodes: BookmarkNode[]): BookmarkCounts {
  let bookmarks = 0;
  let folders = 0;
  const walk = (list: BookmarkNode[]) => {
    for (const node of list) {
      if (node.children === undefined) {
        bookmarks += 1;
        continue;
      }
      folders += 1;
      walk(node.children);
    }
  };
  walk(nodes);
  return { bookmarks, folders };
}

function isBookmarkNode(value: unknown): value is BookmarkNode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const node = value as Partial<BookmarkNode>;
  if (typeof node.title !== 'string') return false;
  if (node.url !== undefined && typeof node.url !== 'string') return false;
  if (node.addedAt !== undefined && typeof node.addedAt !== 'string') return false;
  if (node.children === undefined) return true;
  return Array.isArray(node.children) && node.children.every(isBookmarkNode);
}

export function isBookmarkDocument(value: unknown): value is BookmarkDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BookmarkDocument>;
  return (
    candidate.schemaVersion === BOOKMARK_SCHEMA_VERSION &&
    typeof candidate.generatedAt === 'string' &&
    !!candidate.device &&
    typeof candidate.device.id === 'string' &&
    typeof candidate.device.label === 'string' &&
    typeof candidate.device.browserName === 'string' &&
    (candidate.device.browserFamily === 'chromium' ||
      candidate.device.browserFamily === 'firefox') &&
    Array.isArray(candidate.roots) &&
    candidate.roots.every(isBookmarkNode)
  );
}

export function parseBookmarkJson(text: string): BookmarkDocument {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InventoryFormatError(
      'invalid_json',
      'The selected file is not valid JSON.',
    );
  }

  if (
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    (value as { schemaVersion?: unknown }).schemaVersion !== BOOKMARK_SCHEMA_VERSION
  ) {
    throw new InventoryFormatError(
      'unsupported_schema',
      `This bookmark backup uses unsupported schema version ${String((value as { schemaVersion?: unknown }).schemaVersion)}.`,
    );
  }

  if (!isBookmarkDocument(value)) {
    throw new InventoryFormatError(
      'invalid_inventory',
      'The selected JSON file is not a valid bookmark backup.',
    );
  }

  return value;
}

export function serializeBookmarks(document: BookmarkDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
