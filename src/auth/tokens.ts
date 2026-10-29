import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Entry } from '@napi-rs/keyring';
import type { DeviceCredentials } from '../types.js';

export interface CredentialStore {
  load(): Promise<DeviceCredentials | null>;
  save(c: DeviceCredentials): Promise<void>;
  clear(): Promise<void>;
}

/** Fatia mínima de uma entrada do cofre (o `Entry` do keyring a satisfaz). */
export interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
export type KeyringFactory = (service: string, user: string) => KeyringEntryLike;

export const KEYRING_SERVICE = 'andromeda-agent';
export const KEYRING_USER = 'device';
/** Limite por entrada do cofre (o Credential Manager do Windows aceita ~2 560 bytes UTF-16). */
export const MAX_ENTRY_CHARS = 1280;
const PARTS_RE = /^parts:(\d+)$/;

const realKeyring: KeyringFactory = (service, user) => new Entry(service, user);

function isCredentials(v: unknown): v is DeviceCredentials {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.serverUrl === 'string' &&
    typeof o.accessToken === 'string' &&
    typeof o.refreshToken === 'string' &&
    typeof o.accessExpiresAt === 'number' &&
    typeof o.deviceId === 'string' &&
    typeof o.organizationSlug === 'string'
  );
}

function parseCredentials(text: string): DeviceCredentials | null {
  try {
    const v: unknown = JSON.parse(text);
    return isCredentials(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Cofre do SO. Se o JSON passa de 1 280 caracteres, grava em partes
 * `device.0`, `device.1`... e deixa `parts:N` em `device`.
 */
export class KeyringCredentialStore implements CredentialStore {
  constructor(private readonly factory: KeyringFactory = realKeyring) {}

  private entry(suffix: string | null): KeyringEntryLike {
    return this.factory(KEYRING_SERVICE, suffix === null ? KEYRING_USER : `${KEYRING_USER}.${suffix}`);
  }

  private existingParts(): number {
    const head = this.entry(null).getPassword();
    const m = head === null ? null : PARTS_RE.exec(head);
    return m ? Number(m[1]) : 0;
  }

  async load(): Promise<DeviceCredentials | null> {
    const head = this.entry(null).getPassword();
    if (head === null) return null;
    const m = PARTS_RE.exec(head);
    if (!m) return parseCredentials(head);
    const n = Number(m[1]);
    let text = '';
    for (let i = 0; i < n; i++) {
      const part = this.entry(String(i)).getPassword();
      if (part === null) return null;
      text += part;
    }
    return parseCredentials(text);
  }

  async save(c: DeviceCredentials): Promise<void> {
    const json = JSON.stringify(c);
    const oldParts = this.existingParts();
    let newParts = 0;
    if (json.length <= MAX_ENTRY_CHARS) {
      this.entry(null).setPassword(json);
    } else {
      newParts = Math.ceil(json.length / MAX_ENTRY_CHARS);
      for (let i = 0; i < newParts; i++) {
        this.entry(String(i)).setPassword(json.slice(i * MAX_ENTRY_CHARS, (i + 1) * MAX_ENTRY_CHARS));
      }
      this.entry(null).setPassword(`parts:${newParts}`);
    }
    for (let i = newParts; i < oldParts; i++) this.entry(String(i)).deletePassword();
  }

  async clear(): Promise<void> {
    const n = this.existingParts();
    for (let i = 0; i < n; i++) this.entry(String(i)).deletePassword();
    this.entry(null).deletePassword();
  }
}

function restrictWindowsAcl(file: string, warn: (m: string) => void): Promise<void> {
  return new Promise((resolve) => {
    const user = process.env.USERNAME;
    if (!user) {
      warn('USERNAME ausente; ACL do arquivo de credenciais não restringida');
      resolve();
      return;
    }
    execFile('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { windowsHide: true }, (err) => {
      if (err) warn('não foi possível restringir a ACL do arquivo de credenciais');
      resolve();
    });
  });
}

/** Arquivo `credentials.json` com permissão restrita e gravação atômica. */
export class FileCredentialStore implements CredentialStore {
  readonly path: string;
  constructor(
    private readonly dir: string,
    private readonly warn: (m: string) => void = (m) => process.stderr.write(`aviso: ${m}\n`),
  ) {
    this.path = join(dir, 'credentials.json');
  }

  async load(): Promise<DeviceCredentials | null> {
    try {
      return parseCredentials(await readFile(this.path, 'utf8'));
    } catch {
      return null;
    }
  }

  async save(c: DeviceCredentials): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(c), { mode: 0o600 });
      if (process.platform === 'win32') await restrictWindowsAcl(tmp, this.warn);
      else await chmod(tmp, 0o600);
      await rename(tmp, this.path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/** Tenta o cofre do SO (com um `getPassword` de teste) e cai no arquivo se falhar. */
export function defaultCredentialStore(
  dir: string,
  factory: KeyringFactory = realKeyring,
  warn?: (m: string) => void,
): CredentialStore {
  try {
    factory(KEYRING_SERVICE, KEYRING_USER).getPassword();
    return new KeyringCredentialStore(factory);
  } catch {
    return new FileCredentialStore(dir, warn);
  }
}
