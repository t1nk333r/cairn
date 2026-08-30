import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HsyncResponse } from '../../src/browser/messages';
import type { InventoryDocument } from '../../src/core/inventory';
import './style.css';

async function send(type: 'inventory:get' | 'inventory:capture' | 'options:open') {
  return browser.runtime.sendMessage({ type }) as Promise<HsyncResponse>;
}

function App() {
  const [inventory, setInventory] = useState<InventoryDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (capture: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await send(capture ? 'inventory:capture' : 'inventory:get');
      if (!response.ok) throw new Error(response.error);
      if ('inventory' in response) setInventory(response.inventory);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const enabledCount = useMemo(
    () => inventory?.extensions.filter((item) => item.enabled).length ?? 0,
    [inventory],
  );

  return (
    <main className="popup-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">h</div>
        <div>
          <strong>hsync</strong>
          <span>Extension inventory</span>
        </div>
        <button
          className="icon-button"
          aria-label="Open control center"
          title="Open control center"
          onClick={() => void send('options:open')}
        >
          ↗
        </button>
      </header>

      <section className="status-card">
        <div className="status-line">
          <span className={`status-dot ${error ? 'error' : ''}`} />
          <strong>{error ? 'Needs attention' : inventory ? 'Captured locally' : 'Ready to scan'}</strong>
        </div>
        <p>
          {error ??
            (inventory
              ? `Last scan ${new Date(inventory.generatedAt).toLocaleString()}`
              : 'Create this device’s first extension inventory.')}
        </p>
      </section>

      <section className="metrics" aria-label="Inventory summary">
        <div><strong>{inventory?.extensions.length ?? '—'}</strong><span>Installed</span></div>
        <div><strong>{inventory ? enabledCount : '—'}</strong><span>Enabled</span></div>
        <div><strong>{inventory ? inventory.extensions.length - enabledCount : '—'}</strong><span>Disabled</span></div>
      </section>

      <button className="primary-button" disabled={busy} onClick={() => void refresh(true)}>
        {busy ? 'Scanning…' : inventory ? 'Scan again' : 'Scan extensions'}
      </button>

      <footer>
        <span>{inventory?.device.browserName ?? 'Chromium · Firefox'}</span>
        <button onClick={() => void send('options:open')}>View inventory</button>
      </footer>
    </main>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);

