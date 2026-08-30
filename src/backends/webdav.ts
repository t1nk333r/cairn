import {
  BackendError,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
  type InventoryBackend,
} from './contract';

export interface WebDavConfig {
  baseUrl: string;
  fileName: string;
  username: string;
  password: string;
}

export interface WebDavBackendOptions {
  fetch?: typeof globalThis.fetch;
}

export function normalizeWebDavConfig(config: WebDavConfig): WebDavConfig {
  const baseUrl = config.baseUrl.trim();
  const fileName = config.fileName.trim() || 'hsync.json';
  const username = config.username.trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new BackendError('invalid_config', 'Enter a valid WebDAV folder URL.');
  }

  const localhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.username || parsed.password) {
    throw new BackendError(
      'invalid_config',
      'Do not put credentials in the WebDAV URL. Use the credential fields.',
    );
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localhost)) {
    throw new BackendError(
      'invalid_config',
      'WebDAV requires HTTPS. Plain HTTP is allowed only for localhost.',
    );
  }
  if (!fileName || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName)) {
    throw new BackendError('invalid_config', 'The remote file name cannot contain a path.');
  }
  if (!username) {
    throw new BackendError('invalid_config', 'Enter a WebDAV username.');
  }
  if (!config.password) {
    throw new BackendError('invalid_config', 'Enter a WebDAV password or app password.');
  }

  return {
    baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
    fileName,
    username,
    password: config.password,
  };
}

export function webDavOriginPattern(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  return `${parsed.origin}/*`;
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function responseError(response: Response, action: string): BackendError {
  if (response.status === 401) {
    return new BackendError('authentication', 'WebDAV rejected the credentials.', 401);
  }
  if (response.status === 403) {
    return new BackendError('forbidden', 'WebDAV denied access to this folder.', 403);
  }
  if (response.status === 409 || response.status === 412) {
    return new BackendError(
      'conflict',
      'The remote inventory changed. Pull and compare before uploading again.',
      response.status,
    );
  }
  return new BackendError(
    'server',
    `WebDAV ${action} failed with HTTP ${response.status}.`,
    response.status,
  );
}

export class WebDavBackend implements InventoryBackend {
  private readonly config: WebDavConfig;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly fileUrl: string;
  private readonly headers: HeadersInit;

  constructor(config: WebDavConfig, options: WebDavBackendOptions = {}) {
    this.config = normalizeWebDavConfig(config);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.fileUrl = new URL(encodeURIComponent(this.config.fileName), this.config.baseUrl).href;
    this.headers = {
      Authorization: basicAuthorization(this.config.username, this.config.password),
    };
  }

  async testConnection(): Promise<void> {
    const response = await this.request(this.fileUrl, {
      method: 'HEAD',
      headers: this.headers,
    });
    if (response.ok || response.status === 404) return;
    if (response.status === 405) {
      const fallback = await this.request(this.fileUrl, {
        method: 'GET',
        headers: { ...this.headers, Range: 'bytes=0-0' },
      });
      if (fallback.ok || fallback.status === 404 || fallback.status === 416) return;
      throw responseError(fallback, 'connection test');
    }
    throw responseError(response, 'connection test');
  }

  async read(): Promise<BackendReadResult | null> {
    const response = await this.request(this.fileUrl, {
      method: 'GET',
      headers: this.headers,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw responseError(response, 'download');
    const version = response.headers.get('etag');
    if (!version) {
      throw new BackendError(
        'missing_version',
        'The WebDAV server did not provide an ETag required for safe synchronization.',
      );
    }
    return { data: new Uint8Array(await response.arrayBuffer()), version };
  }

  async write(input: BackendWriteInput): Promise<BackendWriteResult> {
    const conditionalHeaders = input.expectedVersion
      ? { 'If-Match': input.expectedVersion }
      : { 'If-None-Match': '*' };
    const response = await this.request(this.fileUrl, {
      method: 'PUT',
      headers: {
        ...this.headers,
        ...conditionalHeaders,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: input.data as BodyInit,
    });
    if (!response.ok) throw responseError(response, 'upload');
    const directVersion = response.headers.get('etag');
    if (directVersion) return { version: directVersion };

    const head = await this.request(this.fileUrl, {
      method: 'HEAD',
      headers: this.headers,
    });
    if (!head.ok) throw responseError(head, 'version check');
    const version = head.headers.get('etag');
    if (!version) {
      throw new BackendError(
        'missing_version',
        'The WebDAV server accepted the file but did not provide an ETag.',
      );
    }
    return { version };
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (cause) {
      throw new BackendError(
        'network',
        cause instanceof Error ? cause.message : 'Could not reach the WebDAV server.',
      );
    }
  }
}
