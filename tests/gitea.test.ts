import { describe, expect, it, vi } from 'vitest';
import { GiteaBackend, normalizeGiteaConfig } from '../src/backends/gitea';

const config = {
  baseUrl: 'https://git.example.test/gitea/',
  token: 'token-example',
  owner: 'alice',
  repo: 'browser-sync',
  branch: 'main',
  filePath: 'devices/hsync.json',
};

describe('Gitea configuration', () => {
  it('preserves instance subpaths and normalizes the trailing slash', () => {
    expect(normalizeGiteaConfig(config).baseUrl).toBe(
      'https://git.example.test/gitea',
    );
  });

  it('rejects insecure non-local instances', () => {
    expect(() =>
      normalizeGiteaConfig({ ...config, baseUrl: 'http://git.example.test' }),
    ).toThrow('requires HTTPS');
  });
});

describe('GiteaBackend', () => {
  it('checks repository access and the configured branch', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({}),
    );
    const backend = new GiteaBackend(
      { ...config, branch: 'sync/devices' },
      { fetch: fetcher },
    );

    await backend.testConnection();

    expect(fetcher.mock.calls.map(([input]) => input)).toEqual([
      'https://git.example.test/gitea/api/v1/repos/alice/browser-sync',
      'https://git.example.test/gitea/api/v1/repos/alice/browser-sync/branches/sync%2Fdevices',
    ]);
  });

  it('reports a missing configured branch', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const backend = new GiteaBackend(config, { fetch: fetcher });

    await expect(backend.testConnection()).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('reads and decodes Base64 content with a blob SHA version', async () => {
    const payload = new TextEncoder().encode('{"schemaVersion":1}');
    let binary = '';
    for (const byte of payload) binary += String.fromCharCode(byte);
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          type: 'file',
          encoding: 'base64',
          content: `${btoa(binary).slice(0, 8)}\n${btoa(binary).slice(8)}`,
          sha: 'blob-v1',
        }),
    );
    const backend = new GiteaBackend(config, { fetch: fetcher });
    const result = await backend.read();

    expect(new TextDecoder().decode(result?.data)).toBe('{"schemaVersion":1}');
    expect(result?.version).toBe('blob-v1');
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://git.example.test/gitea/api/v1/repos/alice/browser-sync/contents/devices/hsync.json?ref=main',
    );
  });

  it('creates a missing file with POST and no SHA', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ content: { sha: 'blob-v1' } }, { status: 201 }),
    );
    const backend = new GiteaBackend(config, { fetch: fetcher });
    await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: null,
    });
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(request?.method).toBe('POST');
    expect(body).not.toHaveProperty('sha');
    expect(body).toMatchObject({ branch: 'main', message: 'sync: update devices/hsync.json' });
  });

  it('updates with PUT and the expected blob SHA', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ content: { sha: 'blob-v2' } }),
    );
    const backend = new GiteaBackend(config, { fetch: fetcher });
    const result = await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: 'blob-v1',
    });
    const request = fetcher.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(request?.method).toBe('PUT');
    expect(body.sha).toBe('blob-v1');
    expect(result.version).toBe('blob-v2');
  });

  it('maps stale-SHA validation failures to conflicts', async () => {
    const backend = new GiteaBackend(config, {
      fetch: vi.fn(async () => new Response(null, { status: 422 })),
    });
    await expect(
      backend.write({
        data: new TextEncoder().encode('{}'),
        expectedVersion: 'stale',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 422 });
  });
});
