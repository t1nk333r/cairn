const encoder = new TextEncoder();

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignS3RequestInput {
  method: string;
  url: URL;
  region: string;
  credentials: SigV4Credentials;
  payload?: Uint8Array;
  headers?: Record<string, string>;
  now?: Date;
}

const toHex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

async function sha256(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? encoder.encode(value) : value;
  return toHex(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

async function hmac(key: BufferSource, value: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
}

function amzTimestamp(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function canonicalUri(url: URL) {
  return url.pathname
    .split('/')
    .map((segment) =>
      encodeURIComponent(decodeURIComponent(segment)).replace(/[!'()*]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

function canonicalQuery(url: URL) {
  return [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    )
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
}

export async function signS3Request({
  method,
  url,
  region,
  credentials,
  payload = new Uint8Array(),
  headers = {},
  now = new Date(),
}: SignS3RequestInput): Promise<Record<string, string>> {
  const payloadHash = await sha256(payload);
  const timestamp = amzTimestamp(now);
  const dateStamp = timestamp.slice(0, 8);
  const signingHeaders: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
  };
  if (credentials.sessionToken) {
    signingHeaders['x-amz-security-token'] = credentials.sessionToken;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase().startsWith('x-amz-')) {
      signingHeaders[name.toLowerCase()] = value.trim().replace(/\s+/g, ' ');
    }
  }

  const headerNames = Object.keys(signingHeaders).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${signingHeaders[name]}\n`)
    .join('');
  const signedHeaders = headerNames.join(';');
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(url),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    timestamp,
    scope,
    await sha256(canonicalRequest),
  ].join('\n');
  const dateKey = await hmac(encoder.encode(`AWS4${credentials.secretAccessKey}`), dateStamp);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, 's3');
  const signingKey = await hmac(serviceKey, 'aws4_request');
  const signature = toHex(await hmac(signingKey, stringToSign));

  const result: Record<string, string> = {
    ...headers,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp,
    Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (credentials.sessionToken) {
    result['x-amz-security-token'] = credentials.sessionToken;
  }
  return result;
}

