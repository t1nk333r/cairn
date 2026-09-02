// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from '../entrypoints/options/main';
import type { HsyncRequest } from '../src/browser/messages';

// Every upgrade button converts a real remote irreversibly, so the wiring from
// button -> handler -> request type is the one mistake nothing else in the
// suite would catch: a copy-paste slip pointing the S3 button at
// `webdav:upgrade` would migrate the wrong remote silently.

const savedConfigs: Record<string, Record<string, unknown>> = {
  'webdav:get-config': {
    webdavConfig: { baseUrl: 'https://dav.example.test/', fileName: 'cairn.json', username: 'alice' },
  },
  's3:get-config': {
    s3Config: {
      endpoint: 'https://s3.example.test',
      region: 'us-east-1',
      bucket: 'inventories',
      objectKey: 'cairn.json',
      accessKeyId: 'AKIAEXAMPLE',
      forcePathStyle: true,
      hasSessionToken: false,
    },
  },
  'gitea:get-config': {
    giteaConfig: {
      baseUrl: 'https://git.example.test',
      owner: 'alice',
      repo: 'sync',
      branch: 'main',
      filePath: 'cairn.json',
    },
  },
  'github:get-config': {
    githubConfig: {
      apiUrl: 'https://api.github.com',
      owner: 'alice',
      repo: 'sync',
      branch: 'main',
      filePath: 'cairn.json',
    },
  },
};

let sent: HsyncRequest[] = [];
let upgradeReply: { upgraded: boolean };

const inventory = {
  schemaVersion: 1 as const,
  generatedAt: '2026-09-02T00:00:00.000Z',
  device: {
    id: 'laptop',
    label: 'Laptop',
    browserFamily: 'chromium' as const,
    browserName: 'Chromium',
  },
  extensions: [],
};

beforeEach(() => {
  sent = [];
  upgradeReply = { upgraded: true };
  vi.stubGlobal('browser', {
    runtime: {
      sendMessage: async (request: HsyncRequest) => {
        sent.push(request);
        if (request.type.endsWith(':upgrade')) {
          return { ok: true, inventory, upgraded: upgradeReply.upgraded };
        }
        if (request.type in savedConfigs) return { ok: true, ...savedConfigs[request.type] };
        return { ok: true, inventory };
      },
    },
    permissions: { request: async () => true },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const upgradeButtons = async () => {
  render(<App />);
  const buttons = await screen.findAllByRole('button', { name: /Upgrade to multi-device/i });
  // One per connection panel, in document order: GitHub, Gitea, WebDAV, S3.
  await waitFor(() => expect(buttons.every((button) => !button.hasAttribute('disabled'))).toBe(true));
  return buttons;
};

describe('the multi-device upgrade control', () => {
  it('renders exactly one button per backend', async () => {
    expect(await upgradeButtons()).toHaveLength(4);
  });

  it.each([
    [0, 'github:upgrade'],
    [1, 'gitea:upgrade'],
    [2, 'webdav:upgrade'],
    [3, 's3:upgrade'],
  ])('button %i sends %s and no other upgrade request', async (index, expected) => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const buttons = await upgradeButtons();
    buttons[index]!.click();

    await waitFor(() => {
      const upgrades = sent.filter((request) => request.type.endsWith(':upgrade'));
      expect(upgrades.map((request) => request.type)).toEqual([expected]);
    });
  });

  it('asks for confirmation before converting anything', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const buttons = await upgradeButtons();
    buttons[0]!.click();

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    const message = confirm.mock.calls[0]?.[0] ?? '';
    expect(message).toMatch(/cannot be undone|undone|reversed/i);
    expect(message).toMatch(/other device/i);
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const buttons = await upgradeButtons();
    buttons[3]!.click();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.filter((request) => request.type.endsWith(':upgrade'))).toHaveLength(0);
  });

  it('reports an already-upgraded remote as a no-op, not a conversion', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    upgradeReply = { upgraded: false };
    const buttons = await upgradeButtons();
    buttons[2]!.click();

    expect(await screen.findByText(/already in the multi-device format/i)).toBeTruthy();
  });

  it('reports a real conversion distinctly', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const buttons = await upgradeButtons();
    buttons[2]!.click();

    expect(await screen.findByText(/converted to the multi-device format/i)).toBeTruthy();
  });
});

describe('control-center navigation', () => {
  it('lists only sections that exist in the document', async () => {
    const { container } = render(<App />);
    const navIds = Array.from(container.querySelectorAll('nav a')).map((anchor) =>
      (anchor.getAttribute('href') ?? '').replace('#', ''),
    );
    expect(navIds.length).toBeGreaterThan(0);
    for (const id of navIds) {
      expect(container.querySelector(`#${id}`), `nav links to #${id}`).toBeTruthy();
    }
  });

  it('marks the clicked entry as current', async () => {
    const { container } = render(<App />);
    const links = Array.from(container.querySelectorAll('nav a'));
    const target = links[2]!;
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    await waitFor(() => expect(target.getAttribute('aria-current')).toBeTruthy());
    const current = links.filter((link) => link.getAttribute('aria-current'));
    expect(current).toHaveLength(1);
  });
});
