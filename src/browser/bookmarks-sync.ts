// Backend-agnostic bookmark backup: read, conditional write, and the derived
// remote location.
//
// Unlike the extension inventory, bookmark backups are NOT merged across
// devices. Merging two divergent bookmark trees needs move/rename/dedupe
// semantics that no one has specified, and getting it wrong silently mangles
// real user data. Instead a backup is a whole-document write guarded by the
// backend's own version token: a concurrent write fails loudly and the user
// pulls first. That is safe here specifically because restore is additive —
// it never deletes anything — so the worst case is an extra folder, not lost
// bookmarks.
import { BackendError, type InventoryBackend } from '../backends/contract';
import type { BookmarkDocument } from '../core/bookmarks';
import { parseBookmarkJson, serializeBookmarks } from '../core/bookmarks';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Derives the bookmark document's remote name from the inventory's, so one
 * configured connection covers both without a second set of settings fields.
 * `devices/cairn.json` becomes `devices/cairn-bookmarks.json`.
 */
export function bookmarksSibling(path: string): string {
  const slash = path.lastIndexOf('/');
  const directory = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0
    ? `${directory}${name}-bookmarks`
    : `${directory}${name.slice(0, dot)}-bookmarks${name.slice(dot)}`;
}

export interface BookmarkReadResult {
  document: BookmarkDocument;
  version: string;
}

export async function readBookmarkDocument(
  backend: InventoryBackend,
): Promise<BookmarkReadResult | null> {
  const remote = await backend.read();
  if (!remote) return null;
  return {
    document: parseBookmarkJson(decoder.decode(remote.data)),
    version: remote.version,
  };
}

export async function writeBookmarkDocument(input: {
  backend: InventoryBackend;
  document: BookmarkDocument;
  expectedVersion: string | null;
}): Promise<{ version: string }> {
  try {
    return await input.backend.write({
      data: encoder.encode(serializeBookmarks(input.document)),
      expectedVersion: input.expectedVersion,
    });
  } catch (error) {
    if (error instanceof BackendError && error.code === 'conflict') {
      throw new BackendError(
        'conflict',
        'The remote bookmark backup changed since you last pulled it. Pull it first, then back up again.',
      );
    }
    throw error;
  }
}
