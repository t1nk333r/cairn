import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HsyncResponse } from '../../src/browser/messages';
import type { InventoryDocument } from '../../src/core/inventory';
import './style.css';

async function request(type: 'inventory:get' | 'inventory:capture') {
  return browser.runtime.sendMessage({ type }) as Promise<HsyncResponse>;
}

function App() {
  const [inventory, setInventory] = useState<InventoryDocument | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (capture = false) => {
    setBusy(true);
    setError(null);
    try {
      const response = await request(capture ? 'inventory:capture' : 'inventory:get');
      if (!response.ok) throw new Error(response.error);
      if ('inventory' in response) setInventory(response.inventory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return inventory?.extensions ?? [];
    return (inventory?.extensions ?? []).filter((item) =>
      `${item.name} ${item.id}`.toLocaleLowerCase().includes(needle),
    );
  }, [inventory, query]);

  return (
    <div className="app-shell">
      <aside>
        <div className="wordmark"><span>h</span><strong>hsync</strong></div>
        <nav aria-label="Control center">
          <a className="active" href="#overview">Overview</a>
          <a href="#extensions">Extensions</a>
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
          <button disabled={busy} onClick={() => void load(true)}>{busy ? 'Scanning…' : 'Scan now'}</button>
        </header>

        {error && <div className="error-banner">{error}</div>}

        <section className="summary-grid" id="overview">
          <article><span>Installed</span><strong>{inventory?.extensions.length ?? '—'}</strong><small>on this device</small></article>
          <article><span>Enabled</span><strong>{inventory?.extensions.filter((item) => item.enabled).length ?? '—'}</strong><small>currently active</small></article>
          <article><span>Remote</span><strong>—</strong><small>connect storage next</small></article>
          <article><span>Missing</span><strong>—</strong><small>available after first sync</small></article>
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
      </main>
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);

