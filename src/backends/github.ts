import {
  BackendError,
  type BackendReadResult,
  type BackendWriteInput,
  type BackendWriteResult,
  type InventoryBackend,
} from './contract';

export interface GitHubConfig {
  apiUrl: string;
  token: string;
  owner: string;
  repo: string;
  branch: string;
  filePath: string;
}

export interface GitHubBackendOptions {
  fetch?: typeof globalThis.fetch;
}

interface GitHubContentsResponse {
  content?: string | null;
  encoding?: string | null;
  sha?: string;
  type?: string;
}

interface GitHubWriteResponse {
  content?: { sha?: string } | null;
}

const encodePath = (value: string) =>
  value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

export function normalizeGitHubConfig(config: GitHubConfig): GitHubConfig {
  let apiUrl: URL;
  try {
    apiUrl = new URL(config.apiUrl.trim());
  } catch {
    throw new BackendError('invalid_config', 'Enter a valid GitHub API URL.');
  }
  const localhost = apiUrl.hostname === 'localhost' || apiUrl.hostname === '127.0.0.1';
  if (apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && localhost)) {
    throw new BackendError(
      'invalid_config',
      'GitHub requires HTTPS. Plain HTTP is allowed only for localhost.',
    );
  }
  if (apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash) {
    throw new BackendError(
      'invalid_config',
      'The GitHub API URL cannot contain credentials, query parameters, or a fragment.',
    );
  }
  const owner = config.owner.trim();
  const repo = config.repo.trim().replace(/\.git$/i, '');
  const branch = config.branch.trim() || 'main';
  const filePath = config.filePath.trim().replace(/^\/+/, '');
  if (!config.token.trim()) throw new BackendError('invalid_config', 'Enter a GitHub access token.');
  if (!owner) throw new BackendError('invalid_config', 'Enter the repository owner.');
  if (!repo) throw new BackendError('invalid_config', 'Enter the repository name.');
  if (!filePath || filePath.endsWith('/')) {
    throw new BackendError('invalid_config', 'Enter a repository file path.');
  }
  apiUrl.pathname = apiUrl.pathname.replace(/\/+$/, '');
  return {
    apiUrl: apiUrl.href.replace(/\/$/, ''),
    token: config.token.trim(),
    owner,
    repo,
    branch,
    filePath,
  };
}

export function gitHubOriginPattern(apiUrl: string): string {
  return `${new URL(apiUrl).origin}/*`;
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
  const binary = atob(value.replace(/\s+/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function responseError(response: Response, action: string): BackendError {
  if (response.status === 401) {
    return new BackendError('authentication', 'GitHub rejected the access token.', 401);
  }
  if (response.status === 403) {
    return new BackendError(
      'forbidden',
      'GitHub denied repository access. Check Contents permission and branch protection.',
      403,
    );
  }
  if ([409, 422].includes(response.status)) {
    return new BackendError(
      'conflict',
      'The Git file or branch changed. Pull and compare before committing again.',
      response.status,
    );
  }
  return new BackendError('server', `GitHub ${action} failed with HTTP ${response.status}.`, response.status);
}

export class GitHubBackend implements InventoryBackend {
  private readonly config: GitHubConfig;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly repoUrl: string;
  private readonly contentUrl: string;
  private readonly headers: Record<string, string>;

  constructor(config: GitHubConfig, options: GitHubBackendOptions = {}) {
    this.config = normalizeGitHubConfig(config);
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.repoUrl = `${this.config.apiUrl}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
    this.contentUrl = `${this.repoUrl}/contents/${encodePath(this.config.filePath)}`;
    this.headers = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async testConnection(): Promise<void> {
    const repositoryResponse = await this.request(this.repoUrl, { method: 'GET', headers: this.headers });
    if (!repositoryResponse.ok) {
      if (repositoryResponse.status === 404) {
        throw new BackendError('not_found', 'GitHub could not find this repository or the token cannot see it.', 404);
      }
      throw responseError(repositoryResponse, 'connection test');
    }
    const branchResponse = await this.request(
      `${this.repoUrl}/branches/${encodeURIComponent(this.config.branch)}`,
      { method: 'GET', headers: this.headers },
    );
    if (!branchResponse.ok) {
      if (branchResponse.status === 404) {
        throw new BackendError('not_found', `GitHub could not find branch "${this.config.branch}".`, 404);
      }
      throw responseError(branchResponse, 'branch check');
    }
  }

  async read(): Promise<BackendReadResult | null> {
    const url = new URL(this.contentUrl);
    url.searchParams.set('ref', this.config.branch);
    const response = await this.request(url.href, { method: 'GET', headers: this.headers });
    if (response.status === 404) return null;
    if (!response.ok) throw responseError(response, 'download');
    const body = (await response.json()) as GitHubContentsResponse;
    if (body.type !== 'file' || body.encoding !== 'base64' || typeof body.content !== 'string' || typeof body.sha !== 'string') {
      throw new BackendError('server', 'GitHub returned an unsupported or incomplete file response.');
    }
    return { data: decodeBase64(body.content), version: body.sha };
  }

  async write(input: BackendWriteInput): Promise<BackendWriteResult> {
    const response = await this.request(this.contentUrl, {
      method: 'PUT',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        branch: this.config.branch,
        content: encodeBase64(input.data),
        message: `sync: update ${this.config.filePath}`,
        ...(input.expectedVersion ? { sha: input.expectedVersion } : {}),
      }),
    });
    if (!response.ok) throw responseError(response, 'commit');
    const body = (await response.json()) as GitHubWriteResponse;
    const version = body.content?.sha;
    if (!version) {
      throw new BackendError('missing_version', 'GitHub accepted the commit but did not return the new file SHA.');
    }
    return { version };
  }

  private async request(input: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetcher(input, init);
    } catch (cause) {
      throw new BackendError('network', cause instanceof Error ? cause.message : 'Could not reach GitHub.');
    }
  }
}
