import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AppInfoSchema, type AppInfo } from './ipc-contract';

const valid: AppInfo = {
  appVersion: '0.0.0',
  platform: 'linux',
  arch: 'x64',
  electronVersion: '39.0.0',
  nodeVersion: '22.19.0',
};

describe('AppInfoSchema', () => {
  it('accepts a well-formed payload', () => {
    expect(Value.Check(AppInfoSchema, valid)).toBe(true);
  });

  it('rejects a payload with a missing field', () => {
    const { nodeVersion: _omitted, ...broken } = valid;
    expect(Value.Check(AppInfoSchema, broken)).toBe(false);
  });

  it('rejects a payload with a wrong type', () => {
    expect(Value.Check(AppInfoSchema, { ...valid, arch: 64 })).toBe(false);
  });
});
