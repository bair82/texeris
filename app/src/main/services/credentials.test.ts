import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialsService, type Encryptor } from './credentials';

const fakeEncryptor: Encryptor = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (encrypted) => {
    const s = encrypted.toString('utf8');
    if (!s.startsWith('enc:')) {
      throw new Error('bad ciphertext');
    }
    return s.slice(4);
  },
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texeris-creds-'));
  file = path.join(dir, 'credentials.json');
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
});

afterEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.MOONSHOT_API_KEY;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('CredentialsService', () => {
  it('round-trips a key, persisted encrypted on disk', () => {
    const creds = new CredentialsService(fakeEncryptor, file);
    creds.setApiKey('deepseek', 'sk-secret-1');
    expect(creds.getApiKey('deepseek')).toBe('sk-secret-1');

    const onDisk = fs.readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('sk-secret-1'); // encrypted at rest

    // a fresh instance (app restart) reads it back
    const again = new CredentialsService(fakeEncryptor, file);
    expect(again.getApiKey('deepseek')).toBe('sk-secret-1');
  });

  it('stored key wins over env var; env var is the fallback', () => {
    process.env.DEEPSEEK_API_KEY = 'env-key';
    const creds = new CredentialsService(fakeEncryptor, file);
    expect(creds.getApiKey('deepseek')).toBe('env-key');
    expect(creds.keySource('deepseek')).toBe('env');

    creds.setApiKey('deepseek', 'stored-key');
    expect(creds.getApiKey('deepseek')).toBe('stored-key');
    expect(creds.keySource('deepseek')).toBe('keychain');
  });

  it('clear removes the stored key and falls back to env', () => {
    process.env.DEEPSEEK_API_KEY = 'env-key';
    const creds = new CredentialsService(fakeEncryptor, file);
    creds.setApiKey('deepseek', 'stored-key');
    creds.clearApiKey('deepseek');
    expect(creds.getApiKey('deepseek')).toBe('env-key');
    expect(creds.keySource('deepseek')).toBe('env');
  });

  it('reports none when nothing is set', () => {
    const creds = new CredentialsService(fakeEncryptor, file);
    expect(creds.getApiKey('deepseek')).toBeUndefined();
    expect(creds.keySource('moonshotai')).toBe('none');
  });

  it('treats undecryptable ciphertext as unset (keychain changed)', () => {
    const creds = new CredentialsService(fakeEncryptor, file);
    creds.setApiKey('deepseek', 'sk-secret-1');
    // corrupt the stored ciphertext
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    data.deepseek = Buffer.from('garbage').toString('base64');
    fs.writeFileSync(file, JSON.stringify(data));
    expect(new CredentialsService(fakeEncryptor, file).getApiKey('deepseek')).toBeUndefined();
  });
});
