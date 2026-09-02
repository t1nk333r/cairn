import {
  BackendError,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
  type InventoryBackend,
} from './contract';

export interface GiteaConfig {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

export interface GiteaBackendOptions {
  fetch?: typeof globalThis.fetch;
}

interface GiteaContentsResponse {
  content?: string | null;
  encoding?: string | null;
  sha?: string;
  type?: string;
}

interface GiteaFileResponse {
  content?: GiteaContentsResponse;
}

const encodePath = (value: string) =>
  value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

// Repository paths are interpolated into API URLs; a `..` or empty segment can
// walk out of the intended location, and a `.git` segment addresses repository
// internals. Reject them rather than normalizing, so a surprising config fails
// loudly instead of writing somewhere unexpected.
function assertSafeRepositoryPath(filePath: string, label: string): void {
  const segments = filePath.split('/');
  if (
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.toLowerCase() === '.git',
    )
  ) {
    throw new BackendError(
      'invalid_config',
      `The ${label} file path cannot contain empty, "." , ".." or ".git" segments.`,
    );
  }
}

// Branch names reach the API as a path segment and a JSON field. Keep them to
// the conservative subset Git itself accepts, and never let one start with a
// dash, which would read as an option to anything that shells out later.
const SAFE_BRANCH = /^[A-Za-z0-9._\/-]+$/;

function assertSafeBranch(branch: string, label: string): void {
  if (
    !SAFE_BRANCH.test(branch) ||
    branch.includes('..') ||
    branch.startsWith('-') ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock')
  ) {
    throw new BackendError('invalid_config', `Enter a valid ${label} branch name.`);
  }
}

export function normalizeGiteaConfig(config: GiteaConfig): GiteaConfig {
  let baseUrl: URL;
  try {
    baseUrl = new URL(config.baseUrl.trim());
  } catch {
    throw new BackendError('invalid_config', 'Enter a valid Gitea instance URL.');
  }
  const localhost = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1';
  if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && localhost)) {
    throw new BackendError(
      'invalid_config',
      'Gitea requires HTTPS. Plain HTTP is allowed only for localhost.',
    );
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new BackendError(
      'invalid_config',
      'The Gitea URL cannot contain credentials, query parameters, or a fragment.',
    );
  }
  const owner = config.owner.trim();
  const repo = config.repo.trim();
  const branch = config.branch.trim() || 'main';
  const filePath = config.filePath.trim().replace(/^\/+/, '');
  if (!config.token.trim()) throw new BackendError('invalid_config', 'Enter a Gitea access token.');
  if (!owner) throw new BackendError('invalid_config', 'Enter the repository owner.');
  if (!repo) throw new BackendError('invalid_config', 'Enter the repository name.');
  if (!filePath || filePath.endsWith('/')) {
    throw new BackendError('invalid_config', 'Enter a repository file path.');
  }
  assertSafeRepositoryPath(filePath, 'Gitea');
  assertSafeBranch(branch, 'Gitea');
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  return {
    baseUrl: baseUrl.href.replace(/\/$/, ''),
    token: config.token.trim(),
    owner,
    repo,
    branch,
    filePath,
  };
}

export function giteaOriginPattern(baseUrl: string): string {
  return `${new URL(baseUrl).origin}/*`;
}

function encodeBase64(data: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, '');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function responseError(response: Response, action: string): BackendError {
  if (response.status === 401) {
    return new BackendError('authentication', 'Gitea rejected the access token.', 401);
  }
  if (response.status === 403) {
    return new BackendError(
      'forbidden',
      'Gitea denied repository access. Check token permissions and branch protection.',
      403,
    );
  }
  if ([409, 422, 423].includes(response.status)) {
    return new BackendError(
      'conflict',
      'The Gitea file or branch changed. Pull and compare before uploading again.',
      response.status,
    );
  }
  return new BackendError(
    'server',
    `Gitea ${action} failed with HTTP ${response.status}.`,
    response.status,
  );
}

export class GiteaBackend implements InventoryBackend {
  private readonly config: GiteaConfig;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly apiRoot: string;
  private readonly contentUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: GiteaConfig, options: GiteaBackendOptions = {}) {
    this.config = normalizeGiteaConfig(config);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.apiRoot = `${this.config.baseUrl}/api/v1/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
    this.contentUrl = `${this.apiRoot}/contents/${encodePath(this.config.filePath)}`;
    this.headers = {
      Authorization: `token ${this.config.token}`,
      Accept: 'application/json',
    };
  }

  async testConnection(): Promise<void> {
    const repositoryResponse = await this.request(this.apiRoot, {
      method: 'GET',
      headers: this.headers,
    });
    if (!repositoryResponse.ok) {
      if (repositoryResponse.status === 404) {
        throw new BackendError(
          'not_found',
          'Gitea could not find this repository or the token cannot see it.',
          404,
        );
      }
      throw responseError(repositoryResponse, 'connection test');
    }

    const branchResponse = await this.request(
      `${this.apiRoot}/branches/${encodeURIComponent(this.config.branch)}`,
      { method: 'GET', headers: this.headers },
    );
    if (!branchResponse.ok) {
      if (branchResponse.status === 404) {
        throw new BackendError(
          'not_found',
          `Gitea could not find branch "${this.config.branch}".`,
          404,
        );
      }
      throw responseError(branchResponse, 'branch check');
    }
  }

  async read(): Promise<BackendReadResult | null> {
    const url = new URL(this.contentUrl);
    url.searchParams.set('ref', this.config.branch);
    const response = await this.request(url.href, {
      method: 'GET',
      headers: this.headers,
    });
    if (response.status === 404) return null;
    if (!response.ok) throw responseError(response, 'download');
    const body = (await response.json()) as GiteaContentsResponse;
    if (
      body.type !== 'file' ||
      body.encoding !== 'base64' ||
      typeof body.content !== 'string' ||
      typeof body.sha !== 'string'
    ) {
      throw new BackendError(
        'server',
        'Gitea returned an unsupported or incomplete file response.',
      );
    }
    return { data: decodeBase64(body.content), version: body.sha };
  }

  async write(input: BackendWriteInput): Promise<BackendWriteResult> {
    const method = input.expectedVersion ? 'PUT' : 'POST';
    const response = await this.request(this.contentUrl, {
      method,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: this.config.branch,
        content: encodeBase64(input.data),
        message: `sync: update ${this.config.filePath}`,
        ...(input.expectedVersion ? { sha: input.expectedVersion } : {}),
      }),
    });
    if (!response.ok) throw responseError(response, 'upload');
    const body = (await response.json()) as GiteaFileResponse;
    const version = body.content?.sha;
    if (!version) {
      throw new BackendError(
        'missing_version',
        'Gitea accepted the commit but did not return the new file SHA.',
      );
    }
    return { version };
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    try {
      // Never follow a redirect on a credentialed request: the Authorization
      // header would be replayed to whatever host the redirect names.
      return await this.fetcher(input, { ...init, redirect: 'error' });
    } catch (cause) {
      throw new BackendError(
        'network',
        cause instanceof Error ? cause.message : 'Could not reach the Gitea server.',
      );
    }
  }
}
