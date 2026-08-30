import { describe, expect, it, vi } from 'vitest';
import { BackendError } from '../src/backends/contract';
import {
  WebDavBackend,
  normalizeWebDavConfig,
  webDavOriginPattern,
} from '../src/backends/webdav';

const config = {
  baseUrl: 'https://dav.example.test/remote/user/hsync',
  fileName: 'hsync.json',
  username: 'alice',
  password: 'app-password',
};

describe('WebDavBackend', () => {
  it('normalizes folders and produces a narrow origin permission', () => {
    expect(normalizeWebDavConfig(config).baseUrl).toBe(
      'https://dav.example.test/remote/user/hsync/',
    );
    expect(webDavOriginPattern(config.baseUrl)).toBe('https://dav.example.test/*');
  });

  it('rejects insecure non-local endpoints', () => {
    expect(() =>
      normalizeWebDavConfig({ ...config, baseUrl: 'http://dav.example.test/files/' }),
    ).toThrow('requires HTTPS');
  });

  it('rejects credentials embedded in the URL', () => {
    expect(() =>
      normalizeWebDavConfig({
        ...config,
        baseUrl: 'https://alice:secret@dav.example.test/files/',
      }),
    ).toThrow('Do not put credentials');
  });

  it('reads bytes and requires an ETag', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"schemaVersion":1}', {
        status: 200,
        headers: { ETag: '"v1"' },
      }),
    );
    const backend = new WebDavBackend(config, { fetch: fetcher });
    const result = await backend.read();

    expect(new TextDecoder().decode(result?.data)).toBe('{"schemaVersion":1}');
    expect(result?.version).toBe('"v1"');
    expect(fetcher).toHaveBeenCalledWith(
      'https://dav.example.test/remote/user/hsync/hsync.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses If-Match for an update and returns the new ETag', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(null, { status: 204, headers: { ETag: '"v2"' } }),
    );
    const backend = new WebDavBackend(config, { fetch: fetcher });
    const result = await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: '"v1"',
    });

    const request = fetcher.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({ 'If-Match': '"v1"' });
    expect(result.version).toBe('"v2"');
  });

  it('surfaces precondition failures as conflicts', async () => {
    const backend = new WebDavBackend(config, {
      fetch: vi.fn(async () => new Response(null, { status: 412 })),
    });

    await expect(
      backend.write({
        data: new TextEncoder().encode('{}'),
        expectedVersion: '"stale"',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 412 } satisfies Partial<BackendError>);
  });
});
