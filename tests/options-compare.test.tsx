// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { App } from '../entrypoints/options/main';
import type { HsyncRequest } from '../src/browser/messages';
import type { ExtensionInventoryItem, InventoryDocument } from '../src/core/inventory';

// The Compare view summarises four difference categories and then lists them.
// It once counted all four but listed only the remote-only group, so the user
// was told "1 version changes" with no way to learn which extension changed.
// Each category needs its own assertion: the summary number and the detail
// list are produced by separate code, and the counts kept working while the
// lists were missing.

const item = (
  id: string,
  name: string,
  version: string,
  enabled = true,
): ExtensionInventoryItem => ({
  id,
  name,
  version,
  enabled,
  browserFamily: 'chromium',
  type: 'extension',
  installType: 'normal',
  observedAt: '2026-09-02T00:00:00.000Z',
  sourceUrl: `https://chromewebstore.google.com/detail/${id}`,
});

const inventoryOf = (
  label: string,
  extensions: ExtensionInventoryItem[],
): InventoryDocument => ({
  schemaVersion: 1,
  generatedAt: '2026-09-02T00:00:00.000Z',
  device: {
    id: label.toLowerCase(),
    label,
    browserFamily: 'chromium',
    browserName: 'Chromium',
  },
  extensions,
});

// Local has `Here Only` and a newer Tab Manager, and has Reader Mode enabled.
// The baseline has `There Only` instead, an older Tab Manager, and Reader Mode
// disabled — one difference of every kind.
const local = inventoryOf('Laptop', [
  item('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Here Only', '1.0.0'),
  item('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Tab Manager', '3.2.1'),
  item('cccccccccccccccccccccccccccccccc', 'Reader Mode', '1.4.0', true),
]);

const baseline = inventoryOf('Desktop (Firefox)', [
  item('dddddddddddddddddddddddddddddddd', 'There Only', '2.0.0'),
  item('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'Tab Manager', '3.1.0'),
  item('cccccccccccccccccccccccccccccccc', 'Reader Mode', '1.4.0', false),
]);

beforeEach(() => {
  vi.stubGlobal('browser', {
    runtime: {
      sendMessage: async (request: HsyncRequest) => {
        if (request.type === 'baseline:get') return { ok: true, inventory: baseline };
        if (request.type === 'inventory:get' || request.type === 'inventory:capture') {
          return { ok: true, inventory: local };
        }
        return { ok: true, inventory: local };
      },
      getManifest: () => ({ version: '0.1.0' }),
    },
    permissions: { request: async () => true },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// `findByText` and `getByText` throw when a node is absent, so asserting on
// the returned element is the existence check. jest-dom matchers are not
// registered in vitest.config.ts and no other test relies on them.
describe('the Compare view difference lists', () => {
  // A local extension also appears in the Installed list above, so a bare
  // getByText would match twice. Scope each assertion to its own group.
  const groupOf = async (heading: string) => {
    const node = await screen.findByText(heading);
    const group = node.closest('.difference-group');
    if (!group) throw new Error(`"${heading}" is not inside a difference group`);
    return within(group as HTMLElement);
  };

  it('lists the extension only the other device has', async () => {
    render(<App />);
    expect((await groupOf('Missing on this device')).getByText('There Only')).toBeTruthy();
  });

  it('lists the extension only this device has', async () => {
    render(<App />);
    expect((await groupOf('Only on this device')).getByText('Here Only')).toBeTruthy();
  });

  it('names both versions when a version differs', async () => {
    render(<App />);
    expect(await screen.findByText('Version differences')).toBeTruthy();
    expect(screen.getByText('here v3.2.1 · Desktop (Firefox) v3.1.0')).toBeTruthy();
  });

  it('names both states when the enabled state differs', async () => {
    render(<App />);
    expect(await screen.findByText('Enabled-state differences')).toBeTruthy();
    expect(screen.getByText('Enabled here · disabled on Desktop (Firefox)')).toBeTruthy();
  });
});
