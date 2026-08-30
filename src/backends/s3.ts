import {
  BackendError,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
  type InventoryBackend,
} from './contract';
import { signS3Request, type SigV4Credentials } from './sigv4';

export interface S3Config extends SigV4Credentials {
  endpoint: string;
  region: string;
  bucket: string;
  objectKey: string;
  forcePathStyle: boolean;
}

export interface S3BackendOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

const DNS_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export function normalizeS3Config(config: S3Config): S3Config {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint.trim());
  } catch {
    throw new BackendError('invalid_config', 'Enter a valid S3 endpoint URL.');
  }
  const localhost = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1';
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && localhost)) {
    throw new BackendError(
      'invalid_config',
      'S3 requires HTTPS. Plain HTTP is allowed only for localhost.',
    );
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new BackendError(
      'invalid_config',
      'The S3 endpoint cannot contain credentials, query parameters, or a fragment.',
    );
  }
  const bucket = config.bucket.trim();
  const objectKey = config.objectKey.trim().replace(/^\/+/, '');
  const region = config.region.trim() || 'us-east-1';
  if (!bucket) throw new BackendError('invalid_config', 'Enter an S3 bucket.');
  if (!config.forcePathStyle && !DNS_BUCKET.test(bucket)) {
    throw new BackendError(
      'invalid_config',
      'Virtual-host mode requires a DNS-compatible bucket name. Use path-style mode instead.',
    );
  }
  if (!objectKey) throw new BackendError('invalid_config', 'Enter an S3 object key.');
  if (!config.accessKeyId.trim() || !config.secretAccessKey) {
    throw new BackendError('invalid_config', 'Enter the S3 access key and secret key.');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '');
  return {
    endpoint: endpoint.href.replace(/\/$/, ''),
    region,
    bucket,
    objectKey,
    forcePathStyle: config.forcePathStyle,
    accessKeyId: config.accessKeyId.trim(),
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
}

const encodePath = (value: string) =>
  value
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

export function buildS3ObjectUrl(config: S3Config): URL {
  const normalized = normalizeS3Config(config);
  const endpoint = new URL(normalized.endpoint);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  if (normalized.forcePathStyle) {
    endpoint.pathname = `${basePath}/${encodeURIComponent(normalized.bucket)}/${encodePath(normalized.objectKey)}`;
  } else {
    endpoint.hostname = `${normalized.bucket}.${endpoint.hostname}`;
    endpoint.pathname = `${basePath}/${encodePath(normalized.objectKey)}`;
  }
  return endpoint;
}

export function s3OriginPattern(config: S3Config): string {
  return `${buildS3ObjectUrl(config).origin}/*`;
}

function s3ResponseError(response: Response, action: string): BackendError {
  if (response.status === 401) {
    return new BackendError('authentication', 'S3 rejected the credentials.', 401);
  }
  if (response.status === 403) {
    return new BackendError(
      'forbidden',
      'S3 denied the request. Check credentials, bucket policy, clock, region, and CORS.',
      403,
    );
  }
  if (response.status === 409 || response.status === 412) {
    return new BackendError(
      'conflict',
      'The S3 inventory changed. Pull and compare before uploading again.',
      response.status,
    );
  }
  return new BackendError(
    'server',
    `S3 ${action} failed with HTTP ${response.status}.`,
    response.status,
  );
}

export class S3Backend implements InventoryBackend {
  private readonly config: S3Config;
  private readonly url: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;

  constructor(config: S3Config, options: S3BackendOptions = {}) {
    this.config = normalizeS3Config(config);
    this.url = buildS3ObjectUrl(this.config);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
  }

  async testConnection(): Promise<void> {
    const response = await this.request('HEAD');
    if (response.ok || response.status === 404) return;
    throw s3ResponseError(response, 'connection test');
  }

  async read(): Promise<BackendReadResult | null> {
    const response = await this.request('GET');
    if (response.status === 404) return null;
    if (!response.ok) throw s3ResponseError(response, 'download');
    const version = response.headers.get('etag');
    if (!version) {
      throw new BackendError(
        'missing_version',
        'The S3 service did not expose ETag. Add ETag to its CORS ExposeHeaders list.',
      );
    }
    return { data: new Uint8Array(await response.arrayBuffer()), version };
  }

  async write(input: BackendWriteInput): Promise<BackendWriteResult> {
    const response = await this.request('PUT', new Uint8Array(input.data), {
      'Content-Type': 'application/json; charset=utf-8',
      ...(input.expectedVersion
        ? { 'If-Match': input.expectedVersion }
        : { 'If-None-Match': '*' }),
    });
    if (!response.ok) throw s3ResponseError(response, 'upload');
    const version = response.headers.get('etag');
    if (version) return { version };
    const head = await this.request('HEAD');
    if (!head.ok) throw s3ResponseError(head, 'version check');
    const headVersion = head.headers.get('etag');
    if (!headVersion) {
      throw new BackendError(
        'missing_version',
        'S3 accepted the object but did not expose ETag through CORS.',
      );
    }
    return { version: headVersion };
  }

  private async request(
    method: string,
    payload = new Uint8Array(),
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const signedHeaders = await signS3Request({
      method,
      url: this.url,
      region: this.config.region,
      credentials: this.config,
      payload,
      headers,
      now: this.now(),
    });
    try {
      return await this.fetcher(this.url, {
        method,
        headers: signedHeaders,
        ...(method === 'PUT' ? { body: payload as BodyInit } : {}),
      });
    } catch (cause) {
      throw new BackendError(
        'network',
        cause instanceof Error
          ? `${cause.message} Check the S3 endpoint and bucket CORS configuration.`
          : 'Could not reach S3. Check the endpoint and bucket CORS configuration.',
      );
    }
  }
}
