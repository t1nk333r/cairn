import { describe, expect, it, vi } from 'vitest';
import { buildS3ObjectUrl, normalizeS3Config, S3Backend } from '../src/backends/s3';
import { signS3Request } from '../src/backends/sigv4';

const config = {
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'hsync-bucket',
  objectKey: 'profiles/default/hsync.json',
  forcePathStyle: true,
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'secret-example',
};

describe('S3 endpoint handling', () => {
  it('builds path-style URLs for self-hosted services', () => {
    expect(buildS3ObjectUrl(config).href).toBe(
      'https://s3.example.test/hsync-bucket/profiles/default/hsync.json',
    );
  });

  it('builds virtual-host URLs for AWS-style services', () => {
    expect(
      buildS3ObjectUrl({ ...config, forcePathStyle: false }).href,
    ).toBe(
      'https://hsync-bucket.s3.example.test/profiles/default/hsync.json',
    );
  });

  it('allows local HTTP but rejects remote plain HTTP', () => {
    expect(
      normalizeS3Config({ ...config, endpoint: 'http://localhost:9000' }).endpoint,
    ).toBe('http://localhost:9000');
    expect(() =>
      normalizeS3Config({ ...config, endpoint: 'http://minio.example.test' }),
    ).toThrow('requires HTTPS');
  });
});

describe('SigV4 signing', () => {
  it('matches the published AWS S3 GET lifecycle signature vector', async () => {
    const headers = await signS3Request({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?lifecycle'),
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      now: new Date('2013-05-24T00:00:00.000Z'),
    });

    expect(headers.Authorization).toContain(
      'Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543',
    );
  });

  it('produces stable signed headers and signs a session token', async () => {
    const headers = await signS3Request({
      method: 'PUT',
      url: new URL('https://bucket.s3.us-east-1.amazonaws.com/hsync.json'),
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'secret-example',
        sessionToken: 'session-example',
      },
      payload: new TextEncoder().encode('{}'),
      now: new Date('2026-08-30T10:00:00.000Z'),
    });

    expect(headers['x-amz-date']).toBe('20260830T100000Z');
    expect(headers['x-amz-content-sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['x-amz-security-token']).toBe('session-example');
    expect(headers.Authorization).toContain(
      'Credential=AKIDEXAMPLE/20260830/us-east-1/s3/aws4_request',
    );
    expect(headers.Authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    );
  });
});

describe('S3Backend', () => {
  it('uses a signed conditional PUT and returns ETag', async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 200, headers: { ETag: '"v2"' } }),
    );
    const backend = new S3Backend(config, {
      fetch: fetcher,
      now: () => new Date('2026-08-30T10:00:00.000Z'),
    });
    const result = await backend.write({
      data: new TextEncoder().encode('{}'),
      expectedVersion: '"v1"',
    });
    const request = fetcher.mock.calls[0]?.[1];
    expect(request?.headers).toMatchObject({
      'If-Match': '"v1"',
      'x-amz-date': '20260830T100000Z',
    });
    expect(result.version).toBe('"v2"');
  });

  it('surfaces missing CORS access as a network diagnostic', async () => {
    const backend = new S3Backend(config, {
      fetch: vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    });
    await expect(backend.testConnection()).rejects.toThrow(
      'Check the S3 endpoint and bucket CORS configuration',
    );
  });
});
