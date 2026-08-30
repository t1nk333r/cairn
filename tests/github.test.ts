import { describe, expect, it, vi } from 'vitest';
import { GitHubBackend, normalizeGitHubConfig } from '../src/backends/github';

const config = {
  apiUrl: 'https://api.github.com/',
  token: 'github_pat_example',
  owner: 'alice',
  repo: 'browser-sync.git',
  branch: 'main',
  filePath: 'devices/hsync.json',
};

describe('GitHub configuration', () => {
  it('normalizes the API URL and repository suffix', () => {
    expect(normalizeGitHubConfig(config)).toMatchObject({
      apiUrl: 'https://api.github.com',
      repo: 'browser-sync',
    });
  });

  it('rejects insecure non-local API endpoints', () => {
    expect(() => normalizeGitHubConfig({ ...config, apiUrl: 'http://api.example.test' })).toThrow('requires HTTPS');
  });
});

describe('GitHubBackend', () => {
  it('checks repository access and the configured branch', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({}));
    const backend = new GitHubBackend({ ...config, branch: 'sync/devices' }, { fetch: fetcher });
    await backend.testConnection();
    expect(fetcher.mock.calls.map(([input]) => input)).toEqual([
      'https://api.github.com/repos/alice/browser-sync',
      'https://api.github.com/repos/alice/browser-sync/branches/sync%2Fdevices',
    ]);
  });

  it('reads Base64 content and uses its blob SHA as the version', async () => {
    const fetcher = vi.fn(async () => Response.json({
      type: 'file',
      encoding: 'base64',
      content: btoa('{"schemaVersion":1}'),
      sha: 'blob-v1',
    }));
    const result = await new GitHubBackend(config, { fetch: fetcher }).read();
    expect(new TextDecoder().decode(result?.data)).toBe('{"schemaVersion":1}');
    expect(result?.version).toBe('blob-v1');
  });

  it('creates through PUT without a SHA', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ content: { sha: 'blob-v1' } }, { status: 201 }),
    );
    const result = await new GitHubBackend(config, { fetch: fetcher }).write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: null,
    });
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(request?.method).toBe('PUT');
    expect(body).not.toHaveProperty('sha');
    expect(result.version).toBe('blob-v1');
  });

  it('updates through PUT with the expected SHA', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ content: { sha: 'blob-v2' } }),
    );
    const backend = new GitHubBackend(config, { fetch: fetcher });
    await backend.write({ data: new TextEncoder().encode('{}'), expectedVersion: 'blob-v1' });
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.sha).toBe('blob-v1');
  });

  it('maps stale-SHA failures to conflicts', async () => {
    const backend = new GitHubBackend(config, {
      fetch: vi.fn(async () => new Response(null, { status: 409 })),
    });
    await expect(backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: 'stale',
    })).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });
});
