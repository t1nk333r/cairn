import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HsyncRequest, HsyncResponse } from '../../src/browser/messages';
import { diffInventories } from '../../src/core/diff';
import {
  parseInventoryJson,
  serializeInventory,
  type InventoryDocument,
} from '../../src/core/inventory';
import { normalizeWebDavConfig, webDavOriginPattern } from '../../src/backends/webdav';
import { normalizeS3Config, s3OriginPattern } from '../../src/backends/s3';
import { giteaOriginPattern, normalizeGiteaConfig } from '../../src/backends/gitea';
import { gitHubOriginPattern, normalizeGitHubConfig } from '../../src/backends/github';
import type { StoredWebDavConfig } from '../../src/browser/webdav-store';
import './style.css';

async function sendRequest(request: HsyncRequest) {
  return browser.runtime.sendMessage(request) as Promise<HsyncResponse>;
}

function downloadInventory(inventory: InventoryDocument) {
  const blob = new Blob([serializeInventory(inventory)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const device = inventory.device.label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-');
  anchor.href = url;
  anchor.download = `hsync-${device || 'inventory'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

const UPGRADE_CONFIRM_MESSAGE =
  'Convert this remote inventory to the multi-device format? The conversion cannot be undone, and every other device syncing with this remote will need an up-to-date version of hsync to keep reading it.';

const UPGRADE_HELP_TEXT =
  'Multi-device format lets each device record its own state, so two browsers can sync to the same remote without overwriting each other.';

const NAV_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'extensions', label: 'Extensions' },
  { id: 'compare', label: 'Compare' },
  { id: 'restore', label: 'Restore' },
  { id: 'connections', label: 'Connections' },
  { id: 'automation', label: 'Automation' },
  { id: 'safety', label: 'Safety' },
] as const;

function App() {
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
  const [webdavSaved, setWebdavSaved] = useState(false);
  const [s3Saved, setS3Saved] = useState(false);
  const [giteaSaved, setGiteaSaved] = useState(false);
  const [githubSaved, setGitHubSaved] = useState(false);
  const [webdav, setWebdav] = useState({
    baseUrl: '',
    fileName: 'hsync.json',
    username: '',
    password: '',
  });
  const [s3, setS3] = useState({
    endpoint: 'https://s3.amazonaws.com',
    region: 'us-east-1',
    bucket: '',
    objectKey: 'hsync.json',
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
    filePath: 'hsync.json',
  });
  const [github, setGitHub] = useState({
    apiUrl: 'https://api.github.com',
    token: '',
    owner: '',
    repo: '',
    branch: 'main',
    filePath: 'hsync.json',
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
    void sendRequest({ type: 'baseline:get' }).then((response) => {
      if (response.ok && 'inventory' in response) setBaseline(response.inventory);
    });
  }, []);

  useEffect(() => {
    void sendRequest({ type: 'github:get-config' }).then((response) => {
      if (response.ok && 'githubConfig' in response && response.githubConfig) {
        setGitHub((current) => ({ ...current, ...response.githubConfig }));
        setGitHubSaved(true);
      }
    });
  }, []);

  useEffect(() => {
    void sendRequest({ type: 'gitea:get-config' }).then((response) => {
      if (response.ok && 'giteaConfig' in response && response.giteaConfig) {
        setGitea((current) => ({ ...current, ...response.giteaConfig }));
        setGiteaSaved(true);
      }
    });
  }, []);

  useEffect(() => {
    void sendRequest({ type: 's3:get-config' }).then((response) => {
      if (response.ok && 's3Config' in response && response.s3Config) {
        const { hasSessionToken: _hasSessionToken, ...publicConfig } = response.s3Config;
        setS3((current) => ({ ...current, ...publicConfig }));
        setS3Saved(true);
      }
    });
  }, []);

  useEffect(() => {
    void sendRequest({ type: 'webdav:get-config' }).then((response) => {
      if (response.ok && 'webdavConfig' in response && response.webdavConfig) {
        setWebdav((current) => ({ ...current, ...response.webdavConfig }));
        setWebdavSaved(true);
      }
    });
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

  const testAndSaveWebDav = async () => {
    setError(null);
    setNotice(null);
    setRemoteBusy('test');
    try {
      const normalized = normalizeWebDavConfig(webdav);
      const granted = await browser.permissions.request({
        origins: [webDavOriginPattern(normalized.baseUrl)],
      });
      if (!granted) throw new Error('Endpoint access was not granted.');
      const response = await sendRequest({
        type: 'webdav:test-and-save',
        config: normalized,
      });
      if (!response.ok) throw new Error(response.error);
      setWebdav(normalized);
      setWebdavSaved(true);
      setNotice('WebDAV connection verified and saved locally.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runWebDavAction = async (action: 'pull' | 'upload') => {
    setError(null);
    setNotice(null);
    setRemoteBusy(action);
    try {
      const response = await sendRequest({ type: `webdav:${action}` });
      if (!response.ok) throw new Error(response.error);
      if (action === 'pull' && 'inventory' in response) {
        setBaseline(response.inventory);
      }
      setNotice(
        action === 'pull'
          ? 'Remote inventory pulled into Compare.'
          : 'Local inventory uploaded with conflict protection.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runWebDavUpgrade = async () => {
    if (!window.confirm(UPGRADE_CONFIRM_MESSAGE)) return;
    setError(null);
    setNotice(null);
    setRemoteBusy('upgrade');
    try {
      const response = await sendRequest({ type: 'webdav:upgrade' });
      if (!response.ok) throw new Error(response.error);
      setNotice(
        'upgraded' in response && !response.upgraded
          ? 'This inventory is already in the multi-device format.'
          : 'Remote inventory converted to the multi-device format.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const testAndSaveS3 = async () => {
    setError(null);
    setNotice(null);
    setRemoteBusy('s3-test');
    try {
      const normalized = normalizeS3Config(s3);
      const granted = await browser.permissions.request({
        origins: [s3OriginPattern(normalized)],
      });
      if (!granted) throw new Error('S3 endpoint access was not granted.');
      const response = await sendRequest({
        type: 's3:test-and-save',
        config: normalized,
      });
      if (!response.ok) throw new Error(response.error);
      setS3({ ...normalized, sessionToken: normalized.sessionToken ?? '' });
      setS3Saved(true);
      setNotice('S3 connection verified and saved locally.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runS3Action = async (action: 'pull' | 'upload') => {
    setError(null);
    setNotice(null);
    setRemoteBusy(`s3-${action}`);
    try {
      const response = await sendRequest({ type: `s3:${action}` });
      if (!response.ok) throw new Error(response.error);
      if (action === 'pull' && 'inventory' in response) setBaseline(response.inventory);
      setNotice(
        action === 'pull'
          ? 'S3 inventory pulled into Compare.'
          : 'Local inventory uploaded to S3 with conflict protection.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runS3Upgrade = async () => {
    if (!window.confirm(UPGRADE_CONFIRM_MESSAGE)) return;
    setError(null);
    setNotice(null);
    setRemoteBusy('s3-upgrade');
    try {
      const response = await sendRequest({ type: 's3:upgrade' });
      if (!response.ok) throw new Error(response.error);
      setNotice(
        'upgraded' in response && !response.upgraded
          ? 'This inventory is already in the multi-device format.'
          : 'S3 inventory converted to the multi-device format.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const testAndSaveGitea = async () => {
    setError(null);
    setNotice(null);
    setRemoteBusy('gitea-test');
    try {
      const normalized = normalizeGiteaConfig(gitea);
      const granted = await browser.permissions.request({
        origins: [giteaOriginPattern(normalized.baseUrl)],
      });
      if (!granted) throw new Error('Gitea endpoint access was not granted.');
      const response = await sendRequest({
        type: 'gitea:test-and-save',
        config: normalized,
      });
      if (!response.ok) throw new Error(response.error);
      setGitea(normalized);
      setGiteaSaved(true);
      setNotice('Gitea connection verified and saved locally.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const testAndSaveGitHub = async () => {
    setError(null);
    setNotice(null);
    setRemoteBusy('github-test');
    try {
      const normalized = normalizeGitHubConfig(github);
      const granted = await browser.permissions.request({
        origins: [gitHubOriginPattern(normalized.apiUrl)],
      });
      if (!granted) throw new Error('GitHub API access was not granted.');
      const response = await sendRequest({ type: 'github:test-and-save', config: normalized });
      if (!response.ok) throw new Error(response.error);
      setGitHub(normalized);
      setGitHubSaved(true);
      setNotice('Git repository connection verified and saved locally.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runGitHubAction = async (action: 'pull' | 'upload') => {
    setError(null);
    setNotice(null);
    setRemoteBusy(`github-${action}`);
    try {
      const response = await sendRequest({ type: `github:${action}` });
      if (!response.ok) throw new Error(response.error);
      if (action === 'pull' && 'inventory' in response) setBaseline(response.inventory);
      setNotice(
        action === 'pull'
          ? 'Git inventory pulled into Compare.'
          : 'Local inventory committed with conflict protection.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runGitHubUpgrade = async () => {
    if (!window.confirm(UPGRADE_CONFIRM_MESSAGE)) return;
    setError(null);
    setNotice(null);
    setRemoteBusy('github-upgrade');
    try {
      const response = await sendRequest({ type: 'github:upgrade' });
      if (!response.ok) throw new Error(response.error);
      setNotice(
        'upgraded' in response && !response.upgraded
          ? 'This inventory is already in the multi-device format.'
          : 'Git inventory converted to the multi-device format.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runGiteaAction = async (action: 'pull' | 'upload') => {
    setError(null);
    setNotice(null);
    setRemoteBusy(`gitea-${action}`);
    try {
      const response = await sendRequest({ type: `gitea:${action}` });
      if (!response.ok) throw new Error(response.error);
      if (action === 'pull' && 'inventory' in response) setBaseline(response.inventory);
      setNotice(
        action === 'pull'
          ? 'Gitea inventory pulled into Compare.'
          : 'Local inventory committed to Gitea with conflict protection.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
  };

  const runGiteaUpgrade = async () => {
    if (!window.confirm(UPGRADE_CONFIRM_MESSAGE)) return;
    setError(null);
    setNotice(null);
    setRemoteBusy('gitea-upgrade');
    try {
      const response = await sendRequest({ type: 'gitea:upgrade' });
      if (!response.ok) throw new Error(response.error);
      setNotice(
        'upgraded' in response && !response.upgraded
          ? 'This inventory is already in the multi-device format.'
          : 'Gitea inventory converted to the multi-device format.',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemoteBusy(null);
    }
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
        <div className="wordmark"><span>h</span><strong>hsync</strong></div>
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
        <p>Local-only preview<br />Milestone 1</p>
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
            <div className="empty-state"><strong>{inventory ? 'No matching extensions' : 'Capture your first inventory'}</strong><p>hsync excludes itself and records ordinary extensions only.</p></div>
          )}
        </section>

        <section className="compare-card" id="compare">
          <div className="section-heading">
            <div>
              <h2>Compare inventories</h2>
              <p>{baseline ? `${baseline.device.label} · captured ${new Date(baseline.generatedAt).toLocaleString()}` : 'Import an hsync JSON inventory from another browser or device.'}</p>
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
                      {item.sourceUrl ? <a href={item.sourceUrl} target="_blank" rel="noreferrer">Open source ↗</a> : <span className="no-source">Source unknown</span>}
                    </article>
                  ))}
                </div>
              )}
              {comparison.onlyLocal.length === 0 && comparison.onlyRemote.length === 0 && comparison.versionChanges.length === 0 && comparison.stateChanges.length === 0 && (
                <div className="empty-state compact"><strong>Inventories match</strong><p>No extension ID, version, or enabled-state differences were found.</p></div>
              )}
            </div>
          ) : (
            <div className="empty-state compact"><strong>No comparison inventory</strong><p>Export on one device and import on another. Remote backends will automate this next.</p></div>
          )}
        </section>

        <section className="connection-card" id="connections">
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
            <p className="cors-note wide-field">{UPGRADE_HELP_TEXT}</p>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveGitHub()}>
              {remoteBusy === 'github-test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!githubSaved || remoteBusy !== null} onClick={() => void runGitHubUpgrade()}>
                {remoteBusy === 'github-upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!githubSaved || remoteBusy !== null} onClick={() => void runGitHubAction('pull')}>
                {remoteBusy === 'github-pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!githubSaved || !inventory || remoteBusy !== null} onClick={() => void runGitHubAction('upload')}>
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
            <p className="cors-note wide-field">{UPGRADE_HELP_TEXT}</p>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveGitea()}>
              {remoteBusy === 'gitea-test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!giteaSaved || remoteBusy !== null} onClick={() => void runGiteaUpgrade()}>
                {remoteBusy === 'gitea-upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!giteaSaved || remoteBusy !== null} onClick={() => void runGiteaAction('pull')}>
                {remoteBusy === 'gitea-pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!giteaSaved || !inventory || remoteBusy !== null} onClick={() => void runGiteaAction('upload')}>
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
                placeholder="https://cloud.example.com/remote.php/dav/files/user/hsync/"
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
            <p className="cors-note wide-field">{UPGRADE_HELP_TEXT}</p>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveWebDav()}>
              {remoteBusy === 'test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!webdavSaved || remoteBusy !== null} onClick={() => void runWebDavUpgrade()}>
                {remoteBusy === 'upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!webdavSaved || remoteBusy !== null} onClick={() => void runWebDavAction('pull')}>
                {remoteBusy === 'pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!webdavSaved || !inventory || remoteBusy !== null} onClick={() => void runWebDavAction('upload')}>
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
                placeholder="hsync.json"
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
            <p className="cors-note wide-field">{UPGRADE_HELP_TEXT}</p>
          </div>
          <div className="connection-footer">
            <button className="secondary-button" disabled={remoteBusy !== null} onClick={() => void testAndSaveS3()}>
              {remoteBusy === 's3-test' ? 'Testing…' : 'Test & save'}
            </button>
            <div>
              <button className="secondary-button" disabled={!s3Saved || remoteBusy !== null} onClick={() => void runS3Upgrade()}>
                {remoteBusy === 's3-upgrade' ? 'Upgrading…' : 'Upgrade to multi-device'}
              </button>
              <button className="secondary-button" disabled={!s3Saved || remoteBusy !== null} onClick={() => void runS3Action('pull')}>
                {remoteBusy === 's3-pull' ? 'Pulling…' : 'Pull'}
              </button>
              <button disabled={!s3Saved || !inventory || remoteBusy !== null} onClick={() => void runS3Action('upload')}>
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
