import { describe, expect, it, vi } from 'vitest';
import { GiteaBackend, normalizeGiteaConfig } from '../src/backends/gitea';
import { GitHubBackend, normalizeGitHubConfig } from '../src/backends/github';
import { WebDavBackend, normalizeWebDavConfig } from '../src/backends/webdav';
import { S3Backend } from '../src/backends/s3';
import { BackendError } from '../src/backends/contract';
import {
  inferSourceUrl,
  isInventoryDocument,
  safeExternalUrl,
  type ManagementExtensionInfo,
} from '../src/core/inventory';

const giteaConfig = {
  baseUrl: 'https://git.example.test',
  token: 'token-example',
  owner: 'alice',
  repo: 'browser-sync',
  branch: 'main',
  filePath: 'devices/hsync.json',
};

const githubConfig = {
  apiUrl: 'https://api.github.com',
  token: 'token-example',
  owner: 'alice',
  repo: 'browser-sync',
  branch: 'main',
  filePath: 'devices/hsync.json',
};

const managementItem = (
  overrides: Partial<ManagementExtensionInfo> = {},
): ManagementExtensionInfo => ({
  id: 'not-a-store-id',
  name: 'Example',
  version: '1.0.0',
  enabled: true,
  type: 'extension',
  ...overrides,
});

describe('safeExternalUrl', () => {
  it('accepts ordinary web schemes', () => {
    expect(safeExternalUrl('https://example.org/x')).toBe('https://example.org/x');
    expect(safeExternalUrl('http://localhost:8080/x')).toBe('http://localhost:8080/x');
  });

  it('drops script-bearing and non-web schemes', () => {
    for (const value of [
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
    ]) {
      expect(safeExternalUrl(value)).toBeUndefined();
    }
  });

  it('drops values that are not usable strings', () => {
    expect(safeExternalUrl('')).toBeUndefined();
    expect(safeExternalUrl('not a url')).toBeUndefined();
    expect(safeExternalUrl(undefined)).toBeUndefined();
    expect(safeExternalUrl(42)).toBeUndefined();
    expect(safeExternalUrl({ href: 'https://example.org' })).toBeUndefined();
  });
});

describe('inferSourceUrl', () => {
  it('never derives a source URL from a script-bearing homepage or update URL', () => {
    expect(
      inferSourceUrl(
        managementItem({ homepageUrl: 'javascript:alert(1)' }),
        'chromium',
      ),
    ).toBeUndefined();
    expect(
      inferSourceUrl(
        managementItem({ updateUrl: 'data:text/html,<script>' }),
        'firefox',
      ),
    ).toBeUndefined();
  });

  it('falls through to the update URL when the homepage is unusable', () => {
    expect(
      inferSourceUrl(
        managementItem({
          homepageUrl: 'javascript:alert(1)',
          updateUrl: 'https://updates.example.org/manifest.json',
        }),
        'firefox',
      ),
    ).toBe('https://updates.example.org/manifest.json');
  });

  it('still prefers the canonical store URL for a Chromium store id', () => {
    expect(
      inferSourceUrl(
        managementItem({
          id: 'abcdefghijklmnopabcdefghijklmnop',
          homepageUrl: 'javascript:alert(1)',
        }),
        'chromium',
      ),
    ).toBe('https://chromewebstore.google.com/detail/abcdefghijklmnopabcdefghijklmnop');
  });
});

describe('isInventoryDocument URL field types', () => {
  const document = (extra: Record<string, unknown>) => ({
    schemaVersion: 1,
    generatedAt: '2026-09-02T00:00:00.000Z',
    device: {
      id: 'device',
      label: 'Device',
      browserFamily: 'chromium',
      browserName: 'Chromium',
    },
    extensions: [
      {
        id: 'ext',
        browserFamily: 'chromium',
        name: 'Example',
        version: '1.0.0',
        enabled: true,
        type: 'extension',
        observedAt: '2026-09-02T00:00:00.000Z',
        ...extra,
      },
    ],
  });

  it('accepts string URL fields', () => {
    expect(isInventoryDocument(document({ sourceUrl: 'https://example.org' }))).toBe(true);
  });

  it('rejects non-string URL fields', () => {
    expect(isInventoryDocument(document({ sourceUrl: { toString: 'x' } }))).toBe(false);
    expect(isInventoryDocument(document({ homepageUrl: 12 }))).toBe(false);
    expect(isInventoryDocument(document({ updateUrl: ['https://example.org'] }))).toBe(false);
  });
});

describe('repository path and branch validation', () => {
  const cases: Array<[string, string]> = [
    ['traversal', '../../../etc/passwd'],
    ['embedded traversal', 'devices/../../secrets.json'],
    ['git internals', '.git/config'],
    ['nested git internals', 'devices/.git/config'],
    ['empty segment', 'devices//hsync.json'],
    ['dot segment', 'devices/./hsync.json'],
  ];

  for (const [label, filePath] of cases) {
    it(`Gitea rejects ${label}`, () => {
      expect(() => normalizeGiteaConfig({ ...giteaConfig, filePath })).toThrow(BackendError);
    });

    it(`GitHub rejects ${label}`, () => {
      expect(() => normalizeGitHubConfig({ ...githubConfig, filePath })).toThrow(BackendError);
    });
  }

  it('still accepts an ordinary nested path', () => {
    expect(normalizeGiteaConfig(giteaConfig).filePath).toBe('devices/hsync.json');
    expect(normalizeGitHubConfig(githubConfig).filePath).toBe('devices/hsync.json');
  });

  const badBranches = ['--upload-pack=evil', '../main', 'feature branch', 'main.lock', '/main', 'main/'];

  for (const branch of badBranches) {
    it(`rejects branch ${JSON.stringify(branch)}`, () => {
      expect(() => normalizeGiteaConfig({ ...giteaConfig, branch })).toThrow(BackendError);
      expect(() => normalizeGitHubConfig({ ...githubConfig, branch })).toThrow(BackendError);
    });
  }

  it('accepts ordinary branch names', () => {
    for (const branch of ['main', 'release/2.0', 'feature-x', 'v1.2.3']) {
      expect(normalizeGiteaConfig({ ...giteaConfig, branch }).branch).toBe(branch);
      expect(normalizeGitHubConfig({ ...githubConfig, branch }).branch).toBe(branch);
    }
  });
});

describe('credentialed requests never follow redirects', () => {
  const capturingFetch = () => {
    const calls: RequestInit[] = [];
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{}', { status: 404 });
    });
    return { calls, fetcher: fetcher as unknown as typeof globalThis.fetch };
  };

  it('Gitea', async () => {
    const { calls, fetcher } = capturingFetch();
    await new GiteaBackend(normalizeGiteaConfig(giteaConfig), { fetch: fetcher }).read();
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) expect(init.redirect).toBe('error');
  });

  it('GitHub', async () => {
    const { calls, fetcher } = capturingFetch();
    await new GitHubBackend(normalizeGitHubConfig(githubConfig), { fetch: fetcher }).read();
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) expect(init.redirect).toBe('error');
  });

  it('WebDAV', async () => {
    const { calls, fetcher } = capturingFetch();
    const config = normalizeWebDavConfig({
      baseUrl: 'https://dav.example.test/files/',
      fileName: 'hsync.json',
      username: 'alice',
      password: 'secret-value-not-asserted',
    });
    await new WebDavBackend(config, { fetch: fetcher }).read();
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) expect(init.redirect).toBe('error');
  });

  it('S3', async () => {
    const { calls, fetcher } = capturingFetch();
    const backend = new S3Backend(
      {
        endpoint: 'https://s3.example.test',
        region: 'us-east-1',
        bucket: 'inventories',
        objectKey: 'hsync.json',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: 'secret-value-not-asserted',
        forcePathStyle: true,
      },
      { fetch: fetcher },
    );
    await backend.read();
    expect(calls.length).toBeGreaterThan(0);
    for (const init of calls) expect(init.redirect).toBe('error');
  });
});
