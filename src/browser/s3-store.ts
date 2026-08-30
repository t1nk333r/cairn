import type { S3Config } from '../backends/s3';

const PUBLIC_CONFIG_KEY = 's3Config';
const SECRET_CONFIG_KEY = 's3Secrets';
const REMOTE_VERSION_KEY = 's3RemoteVersion';

export interface StoredS3Config {
  endpoint: string;
  region: string;
  bucket: string;
  objectKey: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  hasSessionToken: boolean;
}

interface StoredS3Secrets {
  secretAccessKey: string;
  sessionToken?: string;
}

export async function saveS3Config(config: S3Config): Promise<void> {
  const publicConfig: StoredS3Config = {
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    objectKey: config.objectKey,
    forcePathStyle: config.forcePathStyle,
    accessKeyId: config.accessKeyId,
    hasSessionToken: !!config.sessionToken,
  };
  const secrets: StoredS3Secrets = {
    secretAccessKey: config.secretAccessKey,
    ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
  };
  const current = await browser.storage.local.get(PUBLIC_CONFIG_KEY);
  const previous = current[PUBLIC_CONFIG_KEY] as StoredS3Config | undefined;
  const endpointChanged =
    !previous ||
    previous.endpoint !== publicConfig.endpoint ||
    previous.region !== publicConfig.region ||
    previous.bucket !== publicConfig.bucket ||
    previous.objectKey !== publicConfig.objectKey ||
    previous.forcePathStyle !== publicConfig.forcePathStyle ||
    previous.accessKeyId !== publicConfig.accessKeyId;
  await browser.storage.local.set({
    [PUBLIC_CONFIG_KEY]: publicConfig,
    [SECRET_CONFIG_KEY]: secrets,
  });
  if (endpointChanged) await browser.storage.local.remove(REMOTE_VERSION_KEY);
}

export async function loadS3Config(): Promise<S3Config | null> {
  const stored = await browser.storage.local.get([
    PUBLIC_CONFIG_KEY,
    SECRET_CONFIG_KEY,
  ]);
  const publicConfig = stored[PUBLIC_CONFIG_KEY] as StoredS3Config | undefined;
  const secrets = stored[SECRET_CONFIG_KEY] as StoredS3Secrets | undefined;
  if (!publicConfig || !secrets || typeof secrets.secretAccessKey !== 'string') {
    return null;
  }
  return {
    endpoint: publicConfig.endpoint,
    region: publicConfig.region,
    bucket: publicConfig.bucket,
    objectKey: publicConfig.objectKey,
    forcePathStyle: publicConfig.forcePathStyle,
    accessKeyId: publicConfig.accessKeyId,
    secretAccessKey: secrets.secretAccessKey,
    ...(secrets.sessionToken ? { sessionToken: secrets.sessionToken } : {}),
  };
}

export async function saveS3RemoteVersion(version: string): Promise<void> {
  await browser.storage.local.set({ [REMOTE_VERSION_KEY]: version });
}

export async function loadS3RemoteVersion(): Promise<string | null> {
  const stored = await browser.storage.local.get(REMOTE_VERSION_KEY);
  return typeof stored[REMOTE_VERSION_KEY] === 'string'
    ? stored[REMOTE_VERSION_KEY]
    : null;
}

