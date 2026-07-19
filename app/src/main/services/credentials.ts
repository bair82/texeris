import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteText } from './document';
import { workspaceDir } from './settings';

/**
 * API credentials (plan §4.6): per-provider keys stored in the workspace
 * config dir, encrypted with the OS keychain via Electron safeStorage
 * (gnome-keyring on this machine). Env vars remain the fallback — a stored
 * key wins over the env var (pi-ai auth precedence: explicit > store > env).
 *
 * The encryptor is injected so the service stays Electron-free and testable;
 * main passes Electron's safeStorage.
 */

export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** Provider id → env var fallback (dev path, plan §4.6). */
const ENV_VARS: Record<string, string> = {
  deepseek: 'DEEPSEEK_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
};

export type KeySource = 'keychain' | 'env' | 'none';

interface CredentialsFile {
  [provider: string]: string; // base64 ciphertext
}

export class CredentialsService {
  constructor(
    private readonly encryptor: Encryptor,
    private readonly file: string = path.join(workspaceDir(), 'credentials.json'),
  ) {}

  /** Key for a provider: stored (decrypted) wins, env var is the fallback. */
  getApiKey(provider: string): string | undefined {
    const stored = this.readFile()[provider];
    if (stored) {
      try {
        return this.encryptor.decryptString(Buffer.from(stored, 'base64'));
      } catch {
        // ciphertext unreadable (keychain changed) — treat as unset
      }
    }
    const envVar = ENV_VARS[provider];
    return envVar ? process.env[envVar] : undefined;
  }

  setApiKey(provider: string, key: string): void {
    const trimmed = key.trim();
    if (!trimmed) {
      this.clearApiKey(provider);
      return;
    }
    const data = this.readFile();
    data[provider] = this.encryptor.encryptString(trimmed).toString('base64');
    this.writeFile(data);
  }

  clearApiKey(provider: string): void {
    const data = this.readFile();
    delete data[provider];
    this.writeFile(data);
  }

  keySource(provider: string): KeySource {
    if (this.readFile()[provider]) {
      return 'keychain';
    }
    const envVar = ENV_VARS[provider];
    return envVar && process.env[envVar] ? 'env' : 'none';
  }

  encryptionAvailable(): boolean {
    try {
      return this.encryptor.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Providers we surface in settings (must match models collection). */
  static knownProviders(): string[] {
    return Object.keys(ENV_VARS);
  }

  private readFile(): CredentialsFile {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as CredentialsFile;
    } catch {
      return {};
    }
  }

  private writeFile(data: CredentialsFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteText(this.file, JSON.stringify(data, null, 2) + '\n');
  }
}
