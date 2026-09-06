// The four backend stores each hand-rolled a save/load pair per document
// (inventory and bookmarks) over `browser.storage.local` — sixteen functions
// that differed only by storage key, so any fix to the corrupt-record guard
// had to land eight times.

/** Reader/writer for one backend's stored version token (ETag or commit SHA). */
export interface VersionStore {
  save(version: string): Promise<void>;
  load(): Promise<string | null>;
  clear(): Promise<void>;
}

// The members are arrow properties rather than methods because callers pass
// them straight into `createBackendService` as bare callbacks; a method would
// be invoked without its receiver and lose `key`.
export function versionStore(key: string): VersionStore {
  return {
    save: async (version: string) => {
      await browser.storage.local.set({ [key]: version });
    },
    // Anything that is not a string is a corrupt record, not a version. Report
    // it as absent so the next request goes out unconditional instead of
    // sending garbage as an `If-Match` precondition.
    load: async () => {
      const stored = await browser.storage.local.get(key);
      return typeof stored[key] === 'string' ? stored[key] : null;
    },
    clear: async () => {
      await browser.storage.local.remove(key);
    },
  };
}
