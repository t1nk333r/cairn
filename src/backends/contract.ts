export interface BackendReadResult {
  data: Uint8Array;
  version: string;
}

export interface BackendWriteInput {
  data: Uint8Array;
  expectedVersion: string | null;
}

export interface BackendWriteResult {
  version: string;
}

export interface InventoryBackend {
  read(): Promise<BackendReadResult | null>;
  write(input: BackendWriteInput): Promise<BackendWriteResult>;
  testConnection(): Promise<void>;
}

export type BackendErrorCode =
  | 'authentication'
  | 'conflict'
  | 'forbidden'
  | 'invalid_config'
  | 'missing_version'
  | 'network'
  | 'not_found'
  | 'server';

export class BackendError extends Error {
  constructor(
    public readonly code: BackendErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

