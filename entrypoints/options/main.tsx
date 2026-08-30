import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HsyncRequest, HsyncResponse } from '../../src/browser/messages';
import { diffInventories } from '../../src/core/diff';
import {
  parseInventoryJson,
  serializeInventory,
  type InventoryDocument,
} from '../../src/core/inventory';
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

function App() {
  const [inventory, setInventory] = useState<InventoryDocument | null>(null);
  const [baseline, setBaseline] = useState<InventoryDocument | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          <a className="active" href="#overview">Overview</a>
          <a href="#extensions">Extensions</a>
          <a href="#compare">Compare</a>
          <a href="#restore">Restore</a>
          <a href="#connections">Connections</a>
          <a href="#automation">Automation</a>
          <a href="#safety">Safety</a>
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
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
