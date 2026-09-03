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

/** Normalizes one node and its subtree, without any super-root unwrapping. */
export function normalizeBookmarkNode(node: BookmarkTreeNodeLike): BookmarkNode {
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
      children: (node.children ?? []).map(normalizeBookmarkNode),
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
  return roots.map(normalizeBookmarkNode);
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

/** Child indexes from the document's root list down to one node. Index-based, not title-based: sibling titles are not unique. */
export type BookmarkPath = readonly number[];

export interface BookmarkPathEntry {
  path: number[];
  node: BookmarkNode;
  /** 0 for a root folder. */
  depth: number;
}

/** Depth-first listing of every node, each with the path that addresses it. */
export function listBookmarkPaths(roots: BookmarkNode[]): BookmarkPathEntry[] {
  const entries: BookmarkPathEntry[] = [];
  // Parents before children, so a caller rendering a tree can indent by depth
  // without buffering.
  const walk = (nodes: BookmarkNode[], prefix: readonly number[], depth: number) => {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (node === undefined) continue;
      const path = [...prefix, index];
      entries.push({ path, node, depth });
      if (node.children !== undefined) walk(node.children, path, depth + 1);
    }
  };
  walk(roots, [], 0);
  return entries;
}

interface SelectionMark {
  /** The whole subtree here is selected, which makes any child mark redundant. */
  whole: boolean;
  children: Map<number, SelectionMark>;
}

/**
 * Keeps only the addressed nodes and their subtrees, preserving original order
 * and the folder nesting above each selection. Selecting a folder selects its
 * whole subtree; if both a folder and something inside it are addressed, the
 * folder wins. Throws InventoryFormatError on an empty or out-of-range path.
 */
export function selectBookmarkNodes(
  roots: BookmarkNode[],
  paths: readonly BookmarkPath[],
): BookmarkNode[] {
  const selection: SelectionMark = { whole: false, children: new Map() };

  for (const path of paths) {
    if (path.length === 0) {
      throw new InventoryFormatError(
        'invalid_inventory',
        'A bookmark selection needs at least one index; the document root cannot be selected.',
      );
    }
    let siblings: BookmarkNode[] | undefined = roots;
    let mark = selection;
    for (let step = 0; step < path.length; step += 1) {
      const index = path[step];
      // One lookup rejects every bad index at once: out of range, negative,
      // fractional, or a step past a bookmark, which has no children. Dropping
      // such a path instead would mean a restore that quietly omits data.
      // Annotated because `siblings` is reassigned from `node.children` below,
      // which TypeScript would otherwise treat as circular inference.
      const node: BookmarkNode | undefined =
        index === undefined ? undefined : siblings?.[index];
      if (index === undefined || node === undefined) {
        throw new InventoryFormatError(
          'invalid_inventory',
          `Bookmark selection [${path.join(', ')}] does not address a node in this backup.`,
        );
      }
      let next = mark.children.get(index);
      if (next === undefined) {
        next = { whole: false, children: new Map() };
        mark.children.set(index, next);
      }
      mark = next;
      siblings = node.children;
    }
    mark.whole = true;
  }

  const build = (nodes: BookmarkNode[], mark: SelectionMark): BookmarkNode[] => {
    const kept: BookmarkNode[] = [];
    // Iterating the source keeps sibling order regardless of the order paths
    // arrived in.
    for (let index = 0; index < nodes.length; index += 1) {
      const child = mark.children.get(index);
      const node = nodes[index];
      if (child === undefined || node === undefined) continue;
      if (child.whole) {
        kept.push(node);
        continue;
      }
      kept.push({ ...node, children: build(node.children ?? [], child) });
    }
    return kept;
  };

  return build(roots, selection);
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
