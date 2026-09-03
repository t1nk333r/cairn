import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HsyncRequest, HsyncResponse } from '../../src/browser/messages';
import { diffInventories } from '../../src/core/diff';
import {
  countBookmarks,
  listBookmarkPaths,
  type BookmarkDocument,
  type BookmarkPathEntry,
} from '../../src/core/bookmarks';
import type { BookmarkRootSummary, RestoreSummary } from '../../src/browser/bookmarks';
import {
  BACKUP_INTERVALS,
  DEFAULT_BACKUP_SCHEDULE,
  type BackupRunRecord,
  type BackupTarget,
  type StoredBackupSchedule,
} from '../../src/browser/backup-schedule-store';
import {
  parseInventoryJson,
  serializeInventory,
  type InventoryDocument,
  safeExternalUrl,
} from '../../src/core/inventory';
import { normalizeWebDavConfig, webDavOriginPattern } from '../../src/backends/webdav';
import { normalizeS3Config, s3OriginPattern } from '../../src/backends/s3';
import { giteaOriginPattern, normalizeGiteaConfig } from '../../src/backends/gitea';
import { gitHubOriginPattern, normalizeGitHubConfig } from '../../src/backends/github';
import './style.css';

async function sendRequest(request: HsyncRequest) {
  return browser.runtime.sendMessage(request) as Promise<HsyncResponse>;
}

// Fetches one backend's stored config and hands it to `apply` when one exists.
// The four config loads were identical apart from the response key each
// narrows on and the state pair it hydrates, so the narrowing stays with the
// caller and everything else lives here once.
function loadStoredConfig<T>(
  request: HsyncRequest,
  pick: (response: Extract<HsyncResponse, { ok: true }>) => T | null | undefined,
  apply: (config: T) => void,
) {
  void sendRequest(request).then((response) => {
    if (!response.ok) return;
    const config = pick(response);
    if (config) apply(config);
  });
}

function downloadInventory(inventory: InventoryDocument) {
  const blob = new Blob([serializeInventory(inventory)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const device = inventory.device.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-');
  anchor.href = url;
  anchor.download = `cairn-${device || 'inventory'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const UPGRADE_CONFIRM_MESSAGE =
  'Convert this remote inventory to the multi-device format? The conversion cannot be undone, and every other device syncing with this remote will need an up-to-date version of Cairn to keep reading it.';

const RESTORE_CONFIRM_MESSAGE =
  'Restore this bookmark backup? Everything is recreated inside a new, dated folder under Other bookmarks. Nothing you already have is changed, moved, or deleted \u2014 delete that folder if you change your mind.';

const UPGRADE_HELP_TEXT =
  "Each device keeps its own record of what's installed, so a second browser syncing to the same remote adds to the inventory instead of replacing it. Convert a remote once, from any device.";

// Every entry must correspond to a section id that exists below. Restore,
// Automation, and Safety were listed here before they were built, so clicking
// them highlighted the entry and scrolled nowhere; add each back alongside its
// section, not ahead of it.
const NAV_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'compare', label: 'Compare' },
  { id: 'bookmarks', label: 'Bookmarks' },
  { id: 'automation', label: 'Automation' },
  { id: 'connections', label: 'Connections' },
] as const;

// The connection handlers had the same duplication the service layer had
// before `createBackendService`: four copies each of test-and-save,
// pull/upload, and upgrade, differing only in strings, request types, and
// which state pair they wrote. Each backend now declares those differences in
// a ConnectionSpec and three generic handlers inside App do the work once.
//
// What stays per-backend: `prepareTest`, because each backend has its own
// normalize function, permission origin, and config state to write back — and
// the notices, because users read them and "S3 inventory" is not "Git
// inventory".
type ConnectionKey = 'webdav' | 's3' | 'gitea' | 'github';

interface ConnectionSpec {
  /**
   * Busy keys are load-bearing strings: the render disables and relabels
   * buttons by comparing against these exact values, and
   * `tests/options-upgrade.test.tsx` asserts on them. WebDAV predates the
   * other backends, which is why its keys are unprefixed.
   */
  busy: { test: string; pull: string; upload: string; upgrade: string };
  requests: { pull: HsyncRequest; upload: HsyncRequest; upgrade: HsyncRequest };
  notices: { saved: string; pulled: string; uploaded: string; upgraded: string };
  /** Shown when the user dismisses the host-permission prompt. */
  permissionDenied: string;
  setSaved: (saved: boolean) => void;
  /**
   * Normalizes the current form state and packages what the generic
   * test-and-save handler needs: the origin to request permission for, the
   * message to send, and how to write the normalized config back to the form.
   */
  prepareTest: () => { origin: string; request: HsyncRequest; commit: () => void };
}

// Exported for tests; the module still mounts itself below when a #root
// element exists, which it does not under jsdom.
export function App() {
  const [activeSection, setActiveSection] = useState<string>(
    () => window.location.hash.slice(1) || NAV_SECTIONS[0].id,
  );
  const [inventory, setInventory] = useState<InventoryDocument | null>(null);
  const [baseline, setBaseline] = useState<InventoryDocument | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remoteBusy, setRemoteBusy] = useState<string | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkDocument | null>(null);
  const [restoreSummary, setRestoreSummary] = useState<RestoreSummary | null>(null);
  const [bookmarkTarget, setBookmarkTarget] = useState<'webdav' | 's3' | 'gitea' | 'github'>('webdav');
  // The tree a restore would actually recreate, fetched from the worker rather
  // than assumed, because the selection paths below address exactly it.
  const [restoreSource, setRestoreSource] = useState<BookmarkDocument | null>(null);
  // Index paths joined with '.', so a Set of primitives can drive the
  // checkboxes. Converted back to number[][] when the request is sent.
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([]);
  const [roots, setRoots] = useState<BookmarkRootSummary[]>([]);
  // Empty means every root, which is what a fresh install has: the filter is
  // opt-in, never a way to back up nothing by accident.
  const [includedRootIds, setIncludedRootIds] = useState<readonly string[]>([]);
  const [schedule, setSchedule] = useState<StoredBackupSchedule>(DEFAULT_BACKUP_SCHEDULE);
  const [lastRun, setLastRun] = useState<BackupRunRecord | null>(null);
  const [webdavSaved, setWebdavSaved] = useState(false);
  const [s3Saved, setS3Saved] = useState(false);
  const [giteaSaved, setGiteaSaved] = useState(false);
  const [githubSaved, setGitHubSaved] = useState(false);
  const [webdav, setWebdav] = useState({
    baseUrl: '',
    fileName: 'cairn.json',
    username: '',
    password: '',
  });
  const [s3, setS3] = useState({
    endpoint: 'https://s3.amazonaws.com',
    region: 'us-east-1',
    bucket: '',
    objectKey: 'cairn.json',
    forcePathStyle: false,
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
  });
  const [gitea, setGitea] = useState({
    baseUrl: 'https://gitea.com',
    token: '',
    owner: '',
    repo: '',
    branch: 'main',
    filePath: 'cairn.json',
  });
  const [github, setGitHub] = useState({
    apiUrl: 'https://api.github.com',
    token: '',
    owner: '',
    repo: '',
    branch: 'main',
    filePath: 'cairn.json',
  });
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async (capture = false) => {
    setBusy(true);
    setError(null);
    try {
      const response = await sendRequest({
        type: capture ? 'inventory:capture' : 'inventory:get',
      });
      if (!response.ok) throw new Error(response.error);
      if ('inventory' in response) setInventory(response.inventory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    void sendRequest({ type: 'bookmarks:get' }).then((response) => {
      if (response.ok && 'bookmarks' in response) setBookmarks(response.bookmarks);
    });
  }, []);

  // Refetched after every bookmark action, not just at mount: a scan or a pull
  // changes which document a restore would use, and a stale tree here would
  // mean selection paths pointing into the wrong document.
  const loadRestoreSource = useCallback(async () => {
    const response = await sendRequest({ type: 'bookmarks:restore-source' });
    if (response.ok && 'bookmarks' in response) {
      setRestoreSource(response.bookmarks);
      setSelectedPaths([]);
    }
  }, []);

  useEffect(() => void loadRestoreSource(), [loadRestoreSource]);

  useEffect(() => {
    void sendRequest({ type: 'bookmarks:roots' }).then((response) => {
      if (response.ok && 'roots' in response) setRoots(response.roots);
    });
    void sendRequest({ type: 'bookmarks:selection-get' }).then((response) => {
      if (response.ok && 'rootIds' in response) setIncludedRootIds(response.rootIds);
    });
    void sendRequest({ type: 'schedule:get' }).then((response) => {
      if (!response.ok || !('schedule' in response)) return;
      setSchedule(response.schedule);
      setLastRun(response.lastRun);
    });
  }, []);

  useEffect(() => {
    void sendRequest({ type: 'baseline:get' }).then((response) => {
      if (response.ok && 'inventory' in response) setBaseline(response.inventory);
    });
  }, []);

  // Hydrate every saved connection once at mount. Secrets never come back —
  // the stored configs are public fields only — so each form merges over its
  // defaults and marks itself Configured. S3 additionally drops
  // `hasSessionToken`, a status flag the form has no field for.
  useEffect(() => {
    loadStoredConfig(
      { type: 'github:get-config' },
      (response) => ('githubConfig' in response ? response.githubConfig : null),
      (config) => {
        setGitHub((current) => ({ ...current, ...config }));
        setGitHubSaved(true);
      },
    );
    loadStoredConfig(
      { type: 'gitea:get-config' },
      (response) => ('giteaConfig' in response ? response.giteaConfig : null),
      (config) => {
        setGitea((current) => ({ ...current, ...config }));
        setGiteaSaved(true);
      },
    );
    loadStoredConfig(
      { type: 's3:get-config' },
      (response) => ('s3Config' in response ? response.s3Config : null),
      ({ hasSessionToken: _hasSessionToken, ...publicConfig }) => {
        setS3((current) => ({ ...current, ...publicConfig }));
        setS3Saved(true);
      },
    );
    loadStoredConfig(
      { type: 'webdav:get-config' },
      (response) => ('webdavConfig' in response ? response.webdavConfig : null),
      (config) => {
        setWebdav((current) => ({ ...current, ...config }));
        setWebdavSaved(true);
      },
    );
  }, []);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return inventory?.extensions ?? [];
    return (inventory?.extensions ?? []).filter((item) =>
      `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle),
    );
  }, [inventory, query]);

  const comparison = useMemo(
    () => (inventory && baseline ? diffInventories(inventory, baseline) : null),
    [inventory, baseline],
  );

  // Flattened once per document: the checkbox tree and the request payload
  // must address nodes by the same index paths.
  const restoreEntries: BookmarkPathEntry[] = useMemo(
    () => (restoreSource ? listBookmarkPaths(restoreSource.roots) : []),
    [restoreSource],
  );

  // The difference lists compare "here" against the imported or pulled
  // inventory, so they need a name for the other side. Fall back to neutral
  // wording rather than rendering an empty label.
  const otherDeviceLabel = baseline?.device.label?.trim() || 'the other device';

  const importBaseline = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    try {
      const imported = parseInventoryJson(await file.text());
      const response = await sendRequest({ type: 'baseline:set', inventory: imported });
      if (!response.ok) throw new Error(response.error);
      setBaseline(imported);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  // Rebuilt every render so `prepareTest` closes over the current form state,
  // exactly as the sixteen per-backend handlers it replaces did.
  const connections: Record<ConnectionKey, ConnectionSpec> = {
    webdav: {
      busy: { test: 'test', pull: 'pull', upload: 'upload', upgrade: 'upgrade' },
      requests: {
        pull: { type: 'webdav:pull' },
        upload: { type: 'webdav:upload' },
        upgrade: { type: 'webdav:upgrade' },
      },
      notices: {
        saved: 'WebDAV connection verified and saved locally.',
        pulled: 'Remote inventory pulled into Compare.',
        uploaded: 'Local inventory uploaded with conflict protection.',
        upgraded: 'Remote inventory converted to the multi-device format.',
      },
      permissionDenied: 'Endpoint access was not granted.',
      setSaved: setWebdavSaved,
      prepareTest: () => {
        const normalized = normalizeWebDavConfig(webdav);
        return {
          origin: webDavOriginPattern(normalized.baseUrl),
          request: { type: 'webdav:test-and-save', config: normalized },
          commit: () => setWebdav(normalized),
        };
      },
    },
    s3: {
      busy: { test: 's3-test', pull: 's3-pull', upload: 's3-upload', upgrade: 's3-upgrade' },
      requests: {
        pull: { type: 's3:pull' },
        upload: { type: 's3:upload' },
        upgrade: { type: 's3:upgrade' },
      },
      notices: {
        saved: 'S3 connection verified and saved locally.',
        pulled: 'S3 inventory pulled into Compare.',
        uploaded: 'Local inventory uploaded to S3 with conflict protection.',
        upgraded: 'S3 inventory converted to the multi-device format.',
      },
      permissionDenied: 'S3 endpoint access was not granted.',
      setSaved: setS3Saved,
      prepareTest: () => {
        const normalized = normalizeS3Config(s3);
        return {
          origin: s3OriginPattern(normalized),
          request: { type: 's3:test-and-save', config: normalized },
          // The form keeps `sessionToken` as a string, so an absent token
          // writes back as the empty field.
          commit: () => setS3({ ...normalized, sessionToken: normalized.sessionToken ?? '' }),
        };
      },
    },
    gitea: {
      busy: {
        test: 'gitea-test',
        pull: 'gitea-pull',
        upload: 'gitea-upload',
        upgrade: 'gitea-upgrade',
      },
      requests: {
        pull: { type: 'gitea:pull' },
        upload: { type: 'gitea:upload' },
        upgrade: { type: 'gitea:upgrade' },
      },
      notices: {
        saved: 'Gitea connection verified and saved locally.',
        pulled: 'Gitea inventory pulled into Compare.',
        uploaded: 'Local inventory committed to Gitea with conflict protection.',
        upgraded: 'Gitea inventory converted to the multi-device format.',
      },
      permissionDenied: 'Gitea endpoint access was not granted.',
      setSaved: setGiteaSaved,
      prepareTest: () => {
        const normalized = normalizeGiteaConfig(gitea);
        return {
          origin: giteaOriginPattern(normalized.baseUrl),
          request: { type: 'gitea:test-and-save', config: normalized },
          commit: () => setGitea(normalized),
        };
      },
    },
    github: {
      busy: {
        test: 'github-test',
        pull: 'github-pull',
        upload: 'github-upload',
        upgrade: 'github-upgrade',
      },
      requests: {
        pull: { type: 'github:pull' },
        upload: { type: 'github:upload' },
        upgrade: { type: 'github:upgrade' },
      },
      notices: {
        saved: 'Git repository connection verified and saved locally.',
        pulled: 'Git inventory pulled into Compare.',
        uploaded: 'Local inventory committed with conflict protection.',
        upgraded: 'Git inventory converted to the multi-device format.',
      },
      permissionDenied: 'GitHub API access was not granted.',
      setSaved: setGitHubSaved,
      prepareTest: () => {
        const normalized = normalizeGitHubConfig(github);
        return {
          origin: gitHubOriginPattern(normalized.apiUrl),
          request: { type: 'github:test-and-save', config: normalized },
          commit: () => setGitHub(normalized),
        };
      },
    },
  };

  // Shared wrapper for every remote call: clears the banners, holds the busy
  // key while the call runs, and turns any failure into the error banner —
  // the try/catch/finally every handler used to repeat.
  const withRemoteBusy = async (busyKey: string, task: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setRemoteBusy(busyKey);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const testAndSaveConnection = async (key: ConnectionKey) => {
    const spec = connections[key];
    await withRemoteBusy(spec.busy.test, async () => {
      const prepared = spec.prepareTest();
      // The permission prompt must run here in the click handler, while the
      // user gesture is live; the background worker cannot show it.
      const granted = await browser.permissions.request({ origins: [prepared.origin] });
      if (!granted) throw new Error(spec.permissionDenied);
      const response = await sendRequest(prepared.request);
      if (!response.ok) throw new Error(response.error);
      prepared.commit();
      spec.setSaved(true);
      setNotice(spec.notices.saved);
    });
  };

  const runConnectionAction = async (key: ConnectionKey, action: 'pull' | 'upload') => {
    const spec = connections[key];
    await withRemoteBusy(spec.busy[action], async () => {
      const response = await sendRequest(spec.requests[action]);
      if (!response.ok) throw new Error(response.error);
      // Pull lands in Compare rather than replacing the local inventory.
      if (action === 'pull' && 'inventory' in response) setBaseline(response.inventory);
      setNotice(action === 'pull' ? spec.notices.pulled : spec.notices.uploaded);
    });
  };

  const runConnectionUpgrade = async (key: ConnectionKey) => {
    if (!window.confirm(UPGRADE_CONFIRM_MESSAGE)) return;
    const spec = connections[key];
    await withRemoteBusy(spec.busy.upgrade, async () => {
      const response = await sendRequest(spec.requests.upgrade);
      if (!response.ok) throw new Error(response.error);
      setNotice(
        'upgraded' in response && !response.upgraded
          ? 'This inventory is already in the multi-device format.'
          : spec.notices.upgraded,
      );
    });
  };

  const runBookmarkRequest = async (request: HsyncRequest, busyKey: string) => {
    await withRemoteBusy(busyKey, async () => {
      const response = await sendRequest(request);
      if (!response.ok) throw new Error(response.error);
      if ('bookmarks' in response && response.bookmarks) {
        setBookmarks(response.bookmarks);
        const counts = countBookmarks(response.bookmarks.roots);
        setNotice(`${counts.bookmarks} bookmarks in ${counts.folders} folders.`);
      }
      if ('restore' in response) {
        setRestoreSummary(response.restore);
        setNotice(
          `Restored ${response.restore.createdBookmarks} bookmarks into "${response.restore.folderTitle}".`,
        );
      }
      await loadRestoreSource();
    });
  };

  const restoreBookmarkBackup = async (select?: readonly (readonly number[])[]) => {
    if (!window.confirm(RESTORE_CONFIRM_MESSAGE)) return;
    await runBookmarkRequest({ type: 'bookmarks:restore', select }, 'bookmarks-restore');
  };

  // Every root selected is stored as an empty list, keeping "empty means all"
  // as the single meaning of an unfiltered backup rather than a second
  // representation that drifts when a browser gains a root.
  const setRootSelection = async (ids: readonly string[]) => {
    const next = ids.length === roots.length ? [] : ids;
    setIncludedRootIds(next);
    const response = await sendRequest({ type: 'bookmarks:selection-set', rootIds: next });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    if ('rootIds' in response) setIncludedRootIds(response.rootIds);
  };

  const toggleRoot = async (id: string) => {
    const selected = includedRootIds.length === 0 ? roots.map((root) => root.id) : includedRootIds;
    const next = selected.includes(id)
      ? selected.filter((current) => current !== id)
      : [...selected, id];
    // Unticking the last folder would store an empty list, which means "all"
    // — the opposite of what the click asked for. Refuse it instead.
    if (next.length === 0) {
      setError('Keep at least one folder in the backup, or switch backups off.');
      return;
    }
    setError(null);
    await setRootSelection(next);
  };

  const toggleRestorePath = (key: string) => {
    setSelectedPaths((current) =>
      current.includes(key) ? current.filter((path) => path !== key) : [...current, key],
    );
  };

  const saveSchedule = async (next: StoredBackupSchedule) => {
    setSchedule(next);
    await withRemoteBusy('schedule-save', async () => {
      const response = await sendRequest({ type: 'schedule:set', schedule: next });
      if (!response.ok) throw new Error(response.error);
      if ('schedule' in response) {
        setSchedule(response.schedule);
        setLastRun(response.lastRun);
      }
      setNotice(
        next.enabled
          ? 'Automatic bookmark backups are on.'
          : 'Automatic bookmark backups are off.',
      );
    });
  };

  const runScheduleNow = async () => {
    await withRemoteBusy('schedule-run', async () => {
      const response = await sendRequest({ type: 'schedule:run-now' });
      if (!response.ok) throw new Error(response.error);
      if (!('run' in response)) return;
      setLastRun(response.run);
      // The worker reports a failed run rather than throwing, so surface it
      // here instead of letting a red banner go missing.
      if (!response.run.ok) throw new Error(response.run.error ?? 'The backup failed.');
      setNotice('Backed up now.');
    });
  };

  const clearBaseline = async () => {
    const response = await sendRequest({ type: 'baseline:clear' });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setBaseline(null);
  };

  return (
    <div className="app-shell">
      <aside>
        <div className="wordmark"><img src="/icon/32.png" alt="" width={24} height={24} /><strong>Cairn</strong></div>
        <nav aria-label="Control center">
          {NAV_SECTIONS.map((section) => (
            <a
              key={section.id}
              className={activeSection === section.id ? 'active' : undefined}
              aria-current={activeSection === section.id ? 'page' : undefined}
              href={`#${section.id}`}
              onClick={() => setActiveSection(section.id)}
            >
              {section.label}
            </a>
          ))}
        </nav>
        {/* Read the version from the manifest rather than repeating it here:
            the manifest itself derives it from package.json, so `npm version`
            stays the only place a release is bumped. */}
        <p>Version {browser.runtime.getManifest().version}<br />Extensions and bookmarks</p>
      </aside>
      <main>
        <header>
          <div><span>Control center</span><h1>Extension inventory</h1></div>
          <div className="header-actions">
            <button className="secondary-button" disabled={!inventory} onClick={() => inventory && downloadInventory(inventory)}>Export JSON</button>
            <button disabled={busy} onClick={() => void load(true)}>{busy ? 'Scanning…' : 'Scan now'}</button>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}
        {notice && <div className="success-banner">{notice}</div>}

        <section className="summary-grid" id="overview">
          <article><span>Installed</span><strong>{inventory?.extensions.length ?? '—'}</strong><small>on this device</small></article>
          <article><span>Enabled</span><strong>{inventory?.extensions.filter((item) => item.enabled).length ?? '—'}</strong><small>currently active</small></article>
          <article><span>Compared</span><strong>{baseline?.extensions.length ?? '—'}</strong><small>{baseline ? baseline.device.label : 'import an inventory'}</small></article>
          <article><span>Missing</span><strong>{comparison?.onlyRemote.length ?? '—'}</strong><small>recorded, not installed here</small></article>
        </section>

        <section className="inventory-card" id="extensions">
          <div className="section-heading">
            <div><h2>Installed extensions</h2><p>{inventory ? `${inventory.device.label} · ${inventory.device.browserName}` : 'No inventory captured yet'}</p></div>
            <input aria-label="Search extensions" placeholder="Search name or ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          {visible.length ? (
            <div className="extension-list">
              {visible.map((item) => (
                <article key={`${item.browserFamily}:${item.id}`}>
                  <div className="extension-icon">{item.name.slice(0, 1).toUpperCase()}</div>
                  <div className="extension-copy"><strong>{item.name}</strong><span>{item.id}</span></div>
                  <span className={`badge ${item.enabled ? 'enabled' : ''}`}>{item.enabled ? 'Enabled' : 'Disabled'}</span>
                  <span className="version">v{item.version}</span>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state"><strong>{inventory ? 'No matching extensions' : 'Capture your first inventory'}</strong><p>Cairn excludes itself and records ordinary extensions only.</p></div>
          )}
        </section>

        <section className="compare-card" id="compare">
          <div className="section-heading">
            <div>
              <h2>Compare inventories</h2>
              <p>{baseline ? `${baseline.device.label} · captured ${new Date(baseline.generatedAt).toLocaleString()}` : 'Import a Cairn JSON inventory from another browser or device.'}</p>
            </div>
            <div className="compare-actions">
              <input
                ref={fileInput}
                className="file-input"
                type="file"
                accept="application/json,.json"
                onChange={(event) => void importBaseline(event.target.files?.[0])}
              />
              <button className="secondary-button" onClick={() => fileInput.current?.click()}>Import JSON</button>
              {baseline && <button className="text-button" onClick={() => void clearBaseline()}>Clear</button>}
            </div>
          </div>
          {comparison ? (
            <div className="compare-content">
              <div className="compare-summary">
                <div><strong>{comparison.onlyLocal.length}</strong><span>Only here</span></div>
                <div><strong>{comparison.onlyRemote.length}</strong><span>Missing here</span></div>
                <div><strong>{comparison.versionChanges.length}</strong><span>Version changes</span></div>
                <div><strong>{comparison.stateChanges.length}</strong><span>State changes</span></div>
              </div>
              {comparison.onlyRemote.length > 0 && (
                <div className="difference-group">
                  <h3>Missing on this device</h3>
                  {comparison.onlyRemote.map((item) => (
                    <article key={`remote:${item.browserFamily}:${item.id}`}>
                      <div><strong>{item.name}</strong><span>{item.browserFamily} · v{item.version}</span></div>
                      {safeExternalUrl(item.sourceUrl) ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">Open source ↗</a> : <span className="no-source">Source unknown</span>}
                    </article>
                  ))}
                </div>
              )}
              {/* The summary above counts all four categories, so every one of
                  them needs a list underneath. Only `onlyRemote` was rendered
                  before, which told the user "1 version changes" and then gave
                  no way to find out which extension had changed. */}
              {comparison.onlyLocal.length > 0 && (
                <div className="difference-group">
                  <h3>Only on this device</h3>
                  {comparison.onlyLocal.map((item) => (
                    <article key={`local:${item.browserFamily}:${item.id}`}>
                      <div><strong>{item.name}</strong><span>{item.browserFamily} · v{item.version}</span></div>
                      <span className="no-source">Not in {otherDeviceLabel}</span>
                    </article>
                  ))}
                </div>
              )}
              {comparison.versionChanges.length > 0 && (
                <div className="difference-group">
                  <h3>Version differences</h3>
                  {comparison.versionChanges.map((change) => (
                    <article key={`version:${change.id}`}>
                      <div><strong>{change.name}</strong><span>here v{change.localVersion} · {otherDeviceLabel} v{change.remoteVersion}</span></div>
                    </article>
                  ))}
                </div>
              )}
              {comparison.stateChanges.length > 0 && (
                <div className="difference-group">
                  <h3>Enabled-state differences</h3>
                  {comparison.stateChanges.map((change) => (
                    <article key={`state:${change.id}`}>
                      <div><strong>{change.name}</strong><span>{change.localEnabled ? 'Enabled' : 'Disabled'} here · {change.remoteEnabled ? 'enabled' : 'disabled'} on {otherDeviceLabel}</span></div>
                    </article>
                  ))}
                </div>
              )}
              {comparison.onlyLocal.length === 0 && comparison.onlyRemote.length === 0 && comparison.versionChanges.length === 0 && comparison.stateChanges.length === 0 && (
                <div className="empty-state compact"><strong>Inventories match</strong><p>No extension ID, version, or enabled-state differences were found.</p></div>
              )}
            </div>
          ) : (
            <div className="empty-state compact"><strong>No comparison inventory</strong><p>Pull from a connected remote below, or import a JSON inventory exported from another device.</p></div>
          )}
        </section>

        <section className="compare-card" id="bookmarks">
          <div className="section-heading">
            <div>
              <h2>Bookmarks</h2>
              <p>
                Back up the bookmark tree to the same storage as your extension
                inventory. Restore is additive: it recreates the backup in a new
                dated folder and never touches what you already have.
              </p>
            </div>
            <span className="connection-status">
              {bookmarks
                ? `${countBookmarks(bookmarks.roots).bookmarks} bookmarks · ${countBookmarks(bookmarks.roots).folders} folders`
                : 'Not scanned'}
            </span>
          </div>
          <div className="connection-content">
            <label className="wide-field">
              <span>Back up to</span>
              <select
                value={bookmarkTarget}
                onChange={(event) =>
                  setBookmarkTarget(event.target.value as typeof bookmarkTarget)
                }
              >
                <option value="webdav">WebDAV</option>
                <option value="s3">S3-compatible</option>
                <option value="gitea">Gitea</option>
                <option value="github">GitHub</option>
              </select>
            </label>
            <div className="wide-field">
              <span className="field-label">Folders included in backups</span>
              {roots.length === 0 ? (
                <p className="cors-note">The browser reported no bookmark folders.</p>
              ) : (
                <div className="root-list">
                  {roots.map((root) => (
                    <label key={root.id} className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={includedRootIds.length === 0 || includedRootIds.includes(root.id)}
                        disabled={remoteBusy !== null}
                        onChange={() => void toggleRoot(root.id)}
                      />
                      <span>{root.title || 'Untitled folder'}</span>
                      <small>
                        {root.counts.bookmarks} bookmarks · {root.counts.folders} folders
                      </small>
                    </label>
                  ))}
                </div>
              )}
              <p className="cors-note">
                {includedRootIds.length === 0
                  ? 'Everything is backed up. Untick a folder to keep it out of your remote storage.'
                  : 'Only the ticked folders are captured, by hand and on a schedule.'}
              </p>
            </div>
            {restoreSummary && (
              <p className="cors-note wide-field">
                Last restore created {restoreSummary.createdBookmarks} bookmarks and{' '}
                {restoreSummary.createdFolders} folders in "{restoreSummary.folderTitle}".
                {restoreSummary.skipped > 0
                  ? ` ${restoreSummary.skipped} entries were refused by the browser.`
                  : ''}
              </p>
            )}
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={remoteBusy !== null}
                onClick={() => void runBookmarkRequest({ type: 'bookmarks:capture' }, 'bookmarks-scan')}
              >
                {remoteBusy === 'bookmarks-scan' ? 'Scanning…' : 'Scan bookmarks'}
              </button>
              <button
                className="secondary-button"
                disabled={remoteBusy !== null}
                onClick={() =>
                  void runBookmarkRequest(
                    { type: `${bookmarkTarget}:bookmarks-pull` } as HsyncRequest,
                    'bookmarks-pull',
                  )
                }
              >
                {remoteBusy === 'bookmarks-pull' ? 'Pulling…' : 'Pull backup'}
              </button>
              <button
                disabled={!bookmarks || remoteBusy !== null}
                onClick={() =>
                  void runBookmarkRequest(
                    { type: `${bookmarkTarget}:bookmarks-backup` } as HsyncRequest,
                    'bookmarks-backup',
                  )
                }
              >
                {remoteBusy === 'bookmarks-backup' ? 'Backing up…' : 'Back up'}
              </button>
              <button
                className="secondary-button"
                disabled={remoteBusy !== null}
                onClick={() => void restoreBookmarkBackup()}
              >
                {remoteBusy === 'bookmarks-restore' ? 'Restoring…' : 'Restore into new folder'}
              </button>
            </div>
            {restoreEntries.length > 0 && (
              <div className="wide-field">
                <span className="field-label">Or restore only part of the backup</span>
                <div className="restore-tree">
                  {restoreEntries.map((entry) => {
                    const key = entry.path.join('.');
                    return (
                      <label
                        key={key}
                        className="checkbox-field"
                        style={{ marginLeft: `${entry.depth * 18}px` }}
                      >
                        <input
                          type="checkbox"
                          checked={selectedPaths.includes(key)}
                          disabled={remoteBusy !== null}
                          onChange={() => toggleRestorePath(key)}
                        />
                        <span>{entry.node.title || entry.node.url || 'Untitled'}</span>
                        {entry.node.children ? (
                          <small>{countBookmarks([entry.node]).bookmarks} bookmarks</small>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
                <div className="button-row">
                  <button
                    className="secondary-button"
                    disabled={selectedPaths.length === 0 || remoteBusy !== null}
                    onClick={() =>
                      void restoreBookmarkBackup(
                        selectedPaths.map((key) => key.split('.').map(Number)),
                      )
                    }
                  >
                    {remoteBusy === 'bookmarks-restore'
                      ? 'Restoring…'
                      : `Restore ${selectedPaths.length} selected`}
                  </button>
                </div>
                <p className="cors-note">
                  Ticking a folder restores everything inside it. Whatever you pick lands in
                  one new dated folder, exactly like a full restore.
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="compare-card" id="automation">
          <div className="section-heading">
            <div>
              <h2>Automation</h2>
              <p>
                Back up bookmarks on a schedule without opening this page. The browser
                wakes Cairn when a backup is due, so nothing runs while the browser is
                closed — the next one happens after it starts again.
              </p>
            </div>
            <span className="connection-status">
              {schedule.enabled
                ? BACKUP_INTERVALS.find((interval) => interval.minutes === schedule.everyMinutes)
                    ?.label ?? 'Scheduled'
                : 'Off'}
            </span>
          </div>
          <div className="connection-content">
            <label className="checkbox-field wide-field">
              <input
                type="checkbox"
                checked={schedule.enabled}
                disabled={remoteBusy !== null}
                onChange={(event) =>
                  void saveSchedule({ ...schedule, enabled: event.target.checked })
                }
              />
              <span>Back up bookmarks automatically</span>
            </label>
            <label>
              <span>How often</span>
              <select
                value={schedule.everyMinutes}
                disabled={remoteBusy !== null}
                onChange={(event) =>
                  void saveSchedule({ ...schedule, everyMinutes: Number(event.target.value) })
                }
              >
                {BACKUP_INTERVALS.map((interval) => (
                  <option key={interval.minutes} value={interval.minutes}>
                    {interval.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Back up to</span>
              <select
                value={schedule.target}
                disabled={remoteBusy !== null}
                onChange={(event) =>
                  void saveSchedule({
                    ...schedule,
                    target: event.target.value as BackupTarget,
                  })
                }
              >
                <option value="webdav">WebDAV</option>
                <option value="s3">S3-compatible</option>
                <option value="gitea">Gitea</option>
                <option value="github">GitHub</option>
              </select>
            </label>
            {lastRun && (
              <p className="cors-note wide-field">
                {lastRun.ok
                  ? `Last automatic backup succeeded ${new Date(lastRun.at).toLocaleString()}.`
                  : `Last attempt ${new Date(lastRun.at).toLocaleString()} failed: ${lastRun.error ?? 'unknown error'}`}
              </p>
            )}
            <div className="button-row">
              <button
                className="secondary-button"
                disabled={remoteBusy !== null}
                onClick={() => void runScheduleNow()}
              >
                {remoteBusy === 'schedule-run' ? 'Backing up…' : 'Back up now'}
              </button>
            </div>
            <p className="cors-note wide-field">
              A scheduled backup uses the folder selection above and needs the chosen
              connection already saved, with its host permission granted. Failures are
              reported here rather than thrown away.
            </p>
          </div>
        </section>

        <section className="connection-card" id="connections">
          <div className="section-heading">
            <div>
              <h2>Connections</h2>
              <p>{UPGRADE_HELP_TEXT}</p>
            </div>
          </div>
        </section>

        <section className="connection-card">
          <div className="section-heading">
            <div>
              <h2>Git repository connection</h2>
              <p>Commit through GitHub or a GitHub Enterprise-compatible Contents API.</p>
            </div>
            <span className={`connection-status ${githubSaved ? 'connected' : ''}`}>
              {githubSaved ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="connection-content">
            <label className="wide-field">
              <span>API URL</span>
              <input
                type="url"
                placeholder="https://api.github.com"
                value={github.apiUrl}
                onChange={(event) => {
                  setGitHubSaved(false);
                  setGitHub((current) => ({ ...current, apiUrl: event.target.value }));
                }}
              />
              <small>For GitHub Enterprise, use its REST API base URL.</small>
            </label>
            <label>
              <span>Owner</span>
              <input
                value={github.owner}
                onChange={(event) => {
                  setGitHubSaved(false);
                  setGitHub((current) => ({ ...current, owner: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Repository</span>
              <input
                value={github.repo}
                onChange={(event) => {
                  setGitHubSaved(false);
                  setGitHub((current) => ({ ...current, repo: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Branch</span>
              <input
                value={github.branch}
                onChange={(event) => {
                  setGitHubSaved(false);
                  setGitHub((current) => ({ ...current, branch: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>File path</span>
              <input
                value={github.filePath}
                onChange={(event) => {
                  setGitHubSaved(false);
                  setGitHub((current) => ({ ...current, filePath: event.target.value }));
                }}
              />
            </label>
            <label className="wide-field">
              <span>Access token</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder={githubSaved ? 'Enter again only to change or retest' : ''}
                value={github.token}
                onChange={(event) => {
                  setGitHubSaved(false);
                  setGitHub((current) => ({ ...current, token: event.target.value }));
                }}
              />
              <small>Use a fine-grained token with Contents read/write access to this repository.</small>
            </label>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveConnection('github')}>
              {remoteBusy === 'github-test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!githubSaved || remoteBusy !== null} onClick={() => void runConnectionUpgrade('github')}>
                {remoteBusy === 'github-upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!githubSaved || remoteBusy !== null} onClick={() => void runConnectionAction('github', 'pull')}>
                {remoteBusy === 'github-pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!githubSaved || !inventory || remoteBusy !== null} onClick={() => void runConnectionAction('github', 'upload')}>
                {remoteBusy === 'github-upload' ? 'Committing…' : 'Commit local'}
              </button>
            </div>
          </div>
        </section>

        <section className="connection-card" id="gitea-connection">
          <div className="section-heading">
            <div>
              <h2>Gitea connection</h2>
              <p>Commit the inventory to a repository on gitea.com or a private Gitea instance.</p>
            </div>
            <span className={`connection-status ${giteaSaved ? 'connected' : ''}`}>
              {giteaSaved ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="connection-content">
            <label className="wide-field">
              <span>Instance URL</span>
              <input
                type="url"
                placeholder="https://gitea.example.com"
                value={gitea.baseUrl}
                onChange={(event) => {
                  setGiteaSaved(false);
                  setGitea((current) => ({ ...current, baseUrl: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Owner</span>
              <input
                value={gitea.owner}
                onChange={(event) => {
                  setGiteaSaved(false);
                  setGitea((current) => ({ ...current, owner: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Repository</span>
              <input
                value={gitea.repo}
                onChange={(event) => {
                  setGiteaSaved(false);
                  setGitea((current) => ({ ...current, repo: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Branch</span>
              <input
                value={gitea.branch}
                onChange={(event) => {
                  setGiteaSaved(false);
                  setGitea((current) => ({ ...current, branch: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>File path</span>
              <input
                value={gitea.filePath}
                onChange={(event) => {
                  setGiteaSaved(false);
                  setGitea((current) => ({ ...current, filePath: event.target.value }));
                }}
              />
            </label>
            <label className="wide-field">
              <span>Access token</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder={giteaSaved ? 'Enter again only to change or retest' : ''}
                value={gitea.token}
                onChange={(event) => {
                  setGiteaSaved(false);
                  setGitea((current) => ({ ...current, token: event.target.value }));
                }}
              />
              <small>Use a token restricted to repository read/write access. It stays in this browser profile.</small>
            </label>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveConnection('gitea')}>
              {remoteBusy === 'gitea-test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!giteaSaved || remoteBusy !== null} onClick={() => void runConnectionUpgrade('gitea')}>
                {remoteBusy === 'gitea-upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!giteaSaved || remoteBusy !== null} onClick={() => void runConnectionAction('gitea', 'pull')}>
                {remoteBusy === 'gitea-pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!giteaSaved || !inventory || remoteBusy !== null} onClick={() => void runConnectionAction('gitea', 'upload')}>
                {remoteBusy === 'gitea-upload' ? 'Committing…' : 'Commit local'}
              </button>
            </div>
          </div>
        </section>

        <section className="connection-card" id="webdav-connection">
          <div className="section-heading">
            <div>
              <h2>WebDAV connection</h2>
              <p>Nextcloud, Synology, or another HTTPS WebDAV folder.</p>
            </div>
            <span className={`connection-status ${webdavSaved ? 'connected' : ''}`}>
              {webdavSaved ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="connection-content">
            <label className="wide-field">
              <span>Folder URL</span>
              <input
                type="url"
                placeholder="https://cloud.example.com/remote.php/dav/files/user/cairn/"
                value={webdav.baseUrl}
                onChange={(event) => {
                  setWebdavSaved(false);
                  setWebdav((current) => ({ ...current, baseUrl: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>File name</span>
              <input
                value={webdav.fileName}
                onChange={(event) => {
                  setWebdavSaved(false);
                  setWebdav((current) => ({ ...current, fileName: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Username</span>
              <input
                autoComplete="username"
                value={webdav.username}
                onChange={(event) => {
                  setWebdavSaved(false);
                  setWebdav((current) => ({ ...current, username: event.target.value }));
                }}
              />
            </label>
            <label className="wide-field">
              <span>Password or app password</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder={webdavSaved ? 'Enter again only to change or retest' : ''}
                value={webdav.password}
                onChange={(event) => {
                  setWebdavSaved(false);
                  setWebdav((current) => ({ ...current, password: event.target.value }));
                }}
              />
              <small>Stored only in this browser profile. HTTPS is required except on localhost.</small>
            </label>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveConnection('webdav')}>
              {remoteBusy === 'test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!webdavSaved || remoteBusy !== null} onClick={() => void runConnectionUpgrade('webdav')}>
                {remoteBusy === 'upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!webdavSaved || remoteBusy !== null} onClick={() => void runConnectionAction('webdav', 'pull')}>
                {remoteBusy === 'pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!webdavSaved || !inventory || remoteBusy !== null} onClick={() => void runConnectionAction('webdav', 'upload')}>
                {remoteBusy === 'upload' ? 'Uploading…' : 'Upload local'}
              </button>
            </div>
          </div>
        </section>

        <section className="connection-card" id="s3-connection">
          <div className="section-heading">
            <div>
              <h2>S3-compatible connection</h2>
              <p>AWS S3, Cloudflare R2, MinIO, RustFS, or another SigV4-compatible service.</p>
            </div>
            <span className={`connection-status ${s3Saved ? 'connected' : ''}`}>
              {s3Saved ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="connection-content">
            <label className="wide-field">
              <span>Endpoint</span>
              <input
                type="url"
                placeholder="https://s3.amazonaws.com"
                value={s3.endpoint}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, endpoint: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Region</span>
              <input
                placeholder="us-east-1"
                value={s3.region}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, region: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Bucket</span>
              <input
                value={s3.bucket}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, bucket: event.target.value }));
                }}
              />
            </label>
            <label className="wide-field">
              <span>Object key</span>
              <input
                placeholder="cairn.json"
                value={s3.objectKey}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, objectKey: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Access key ID</span>
              <input
                autoComplete="username"
                value={s3.accessKeyId}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, accessKeyId: event.target.value }));
                }}
              />
            </label>
            <label>
              <span>Secret access key</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder={s3Saved ? 'Enter again only to change or retest' : ''}
                value={s3.secretAccessKey}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, secretAccessKey: event.target.value }));
                }}
              />
            </label>
            <label className="wide-field">
              <span>Session token (optional)</span>
              <input
                type="password"
                value={s3.sessionToken}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, sessionToken: event.target.value }));
                }}
              />
            </label>
            <label className="checkbox-field wide-field">
              <input
                type="checkbox"
                checked={s3.forcePathStyle}
                onChange={(event) => {
                  setS3Saved(false);
                  setS3((current) => ({ ...current, forcePathStyle: event.target.checked }));
                }}
              />
              <span>Use path-style addressing (recommended for MinIO, RustFS, localhost, and buckets containing dots)</span>
            </label>
            <p className="cors-note wide-field">The bucket must allow GET, HEAD, and PUT from this extension and expose the ETag response header through CORS.</p>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveConnection('s3')}>
              {remoteBusy === 's3-test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!s3Saved || remoteBusy !== null} onClick={() => void runConnectionUpgrade('s3')}>
                {remoteBusy === 's3-upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!s3Saved || remoteBusy !== null} onClick={() => void runConnectionAction('s3', 'pull')}>
                {remoteBusy === 's3-pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!s3Saved || !inventory || remoteBusy !== null} onClick={() => void runConnectionAction('s3', 'upload')}>
                {remoteBusy === 's3-upload' ? 'Uploading…' : 'Upload local'}
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
