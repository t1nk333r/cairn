import { describe, expect, it } from 'vitest';
import { diffInventories } from '../src/core/diff';
import type { ExtensionInventoryItem, InventoryDocument } from '../src/core/inventory';

const item = (
  id: string,
  overrides: Partial<ExtensionInventoryItem> = {},
): ExtensionInventoryItem => ({
  id,
  browserFamily: 'chromium',
  name: id,
  version: '1.0.0',
  enabled: true,
  type: 'extension',
  observedAt: '2026-08-30T10:00:00.000Z',
  ...overrides,
});

const document = (extensions: ExtensionInventoryItem[]): InventoryDocument => ({
  schemaVersion: 1,
  generatedAt: '2026-08-30T10:00:00.000Z',
  device: {
    id: 'device',
    label: 'Device',
    browserFamily: 'chromium',
    browserName: 'Chromium',
  },
  extensions,
});

describe('diffInventories', () => {
  it('finds local, remote, version, and enabled-state differences', () => {
    const result = diffInventories(
      document([item('local'), item('versioned'), item('state')]),
      document([
        item('remote'),
        item('versioned', { version: '2.0.0' }),
        item('state', { enabled: false }),
      ]),
    );

    expect(result.onlyLocal.map((entry) => entry.id)).toEqual(['local']);
    expect(result.onlyRemote.map((entry) => entry.id)).toEqual(['remote']);
    expect(result.versionChanges).toHaveLength(1);
    expect(result.stateChanges).toHaveLength(1);
  });

  it('does not match identical IDs across browser families', () => {
    const result = diffInventories(
      document([item('same')]),
      document([item('same', { browserFamily: 'firefox' })]),
    );
    expect(result.onlyLocal).toHaveLength(1);
    expect(result.onlyRemote).toHaveLength(1);
  });
});

