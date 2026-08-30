export const NATIVE_HOST_NAME = 'dev.t1nk333r.hsync';
export const NATIVE_PROTOCOL_VERSION = 1;

export interface NativeHello {
  hostName: string;
  hostVersion: string;
  protocolVersions: number[];
  capabilities: string[];
}

export interface NativeGitConfig {
  remoteUrl: string;
  branch: string;
  filePath: string;
}

export interface NativeGitReadResult {
  dataBase64: string;
  version: string;
}

export interface NativeGitWriteResult {
  version: string;
}

interface NativeResponse {
  protocolVersion: number;
  requestId?: string;
  event: string;
  result?: unknown;
  error?: {
    code?: unknown;
    message?: unknown;
    retryable?: unknown;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function createHelloRequest(requestId: string = crypto.randomUUID()) {
  return {
    protocolVersion: NATIVE_PROTOCOL_VERSION,
    requestId,
    command: 'hello' as const,
  };
}

export function createNativeRequest(
  command:
    | 'testConnection'
    | 'readInventory'
    | 'writeInventory'
    | 'setSecret'
    | 'deleteSecret',
  payload: object,
  requestId: string = crypto.randomUUID(),
) {
  return { protocolVersion: NATIVE_PROTOCOL_VERSION, requestId, command, payload };
}

export function parseNativeResult(value: unknown, expectedRequestId: string): unknown {
  if (!isObject(value)) throw new Error('The native companion returned an invalid response.');
  const response = value as unknown as NativeResponse;
  if (response.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new Error('The native companion uses an unsupported protocol version.');
  }
  if (response.requestId !== expectedRequestId) {
    throw new Error('The native companion response did not match this request.');
  }
  if (response.event === 'failed') {
    const message = response.error?.message;
    throw new Error(typeof message === 'string' ? message : 'The native companion rejected the request.');
  }
  if (response.event !== 'completed') {
    throw new Error('The native companion returned an incomplete response.');
  }
  return response.result;
}

export function parseHelloResponse(value: unknown, expectedRequestId: string): NativeHello {
  const result = parseNativeResult(value, expectedRequestId);
  if (!isObject(result)) {
    throw new Error('The native companion returned an incomplete handshake.');
  }
  const { hostName, hostVersion, protocolVersions, capabilities } = result;
  if (
    hostName !== NATIVE_HOST_NAME ||
    typeof hostVersion !== 'string' ||
    !Array.isArray(protocolVersions) ||
    !protocolVersions.every((item) => Number.isInteger(item)) ||
    !Array.isArray(capabilities) ||
    !capabilities.every((item) => typeof item === 'string')
  ) {
    throw new Error('The native companion returned invalid capability information.');
  }
  return { hostName, hostVersion, protocolVersions, capabilities } as NativeHello;
}
