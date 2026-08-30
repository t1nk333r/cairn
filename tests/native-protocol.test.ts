import { describe, expect, it } from 'vitest';
import {
  createHelloRequest,
  createNativeRequest,
  NATIVE_HOST_NAME,
  parseHelloResponse,
  parseNativeResult,
} from '../src/native/protocol';

describe('native companion protocol', () => {
  it('creates a correlated version 1 hello request', () => {
    expect(createHelloRequest('req-1')).toEqual({
      protocolVersion: 1,
      requestId: 'req-1',
      command: 'hello',
    });
  });

  it('creates a typed Git command request', () => {
    expect(createNativeRequest('readInventory', {
      remoteUrl: 'https://git.example.test/repo.git',
      branch: 'main',
      filePath: 'hsync.json',
    }, 'req-git')).toMatchObject({
      protocolVersion: 1,
      requestId: 'req-git',
      command: 'readInventory',
    });
  });

  it('accepts a completed Git result', () => {
    expect(parseNativeResult({
      protocolVersion: 1,
      requestId: 'req-git',
      event: 'completed',
      result: { version: 'revision-1' },
    }, 'req-git')).toEqual({ version: 'revision-1' });
  });

  it('accepts a valid hello response', () => {
    expect(parseHelloResponse({
      protocolVersion: 1,
      requestId: 'req-1',
      event: 'completed',
      result: {
        hostName: NATIVE_HOST_NAME,
        hostVersion: '0.1.0',
        protocolVersions: [1],
        capabilities: ['hello'],
      },
    }, 'req-1')).toMatchObject({ hostVersion: '0.1.0', capabilities: ['hello'] });
  });

  it('rejects a response for another request', () => {
    expect(() => parseHelloResponse({
      protocolVersion: 1,
      requestId: 'req-other',
      event: 'completed',
      result: {},
    }, 'req-1')).toThrow('did not match');
  });

  it('surfaces structured host failures', () => {
    expect(() => parseHelloResponse({
      protocolVersion: 1,
      requestId: 'req-1',
      event: 'failed',
      error: { code: 'unsupported_protocol', message: 'Upgrade required', retryable: false },
    }, 'req-1')).toThrow('Upgrade required');
  });

  it('rejects a spoofed host identity', () => {
    expect(() => parseHelloResponse({
      protocolVersion: 1,
      requestId: 'req-1',
      event: 'completed',
      result: {
        hostName: 'other.host',
        hostVersion: '0.1.0',
        protocolVersions: [1],
        capabilities: ['hello'],
      },
    }, 'req-1')).toThrow('invalid capability');
  });
});
