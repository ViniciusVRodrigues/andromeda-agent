import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultCredentialStore,
  FileCredentialStore,
  KeyringCredentialStore,
  MAX_ENTRY_CHARS,
  type KeyringEntryLike,
  type KeyringFactory,
} from '../../src/auth/tokens.js';
import type { DeviceCredentials } from '../../src/types.js';

function makeCreds(pad = 0): DeviceCredentials {
  return {
    serverUrl: 'https://s.example.com',
    accessToken: 'a'.repeat(10 + pad),
    refreshToken: 'r',
    accessExpiresAt: 123,
    deviceId: 'd',
    organizationSlug: 'o',
  };
}

/** Cria credenciais cujo JSON tem exatamente `len` caracteres. */
function credsOfLength(len: number): DeviceCredentials {
  const base = JSON.stringify(makeCreds(0)).length;
  const c = makeCreds(len - base);
  assert.equal(JSON.stringify(c).length, len);
  return c;
}

function fakeVault() {
  const map = new Map<string, string>();
  const factory: KeyringFactory = (service, user): KeyringEntryLike => {
    const k = `${service}/${user}`;
    return {
      getPassword: () => map.get(k) ?? null,
      setPassword: (p) => {
        assert.ok(p.length <= MAX_ENTRY_CHARS, 'entrada acima do limite');
        map.set(k, p);
      },
      deletePassword: () => map.delete(k),
    };
  };
  return { map, factory };
}

test('keyring: 1 280 caracteres cabem numa entrada só', async () => {
  const v = fakeVault();
  const s = new KeyringCredentialStore(v.factory);
  const c = credsOfLength(1280);
  await s.save(c);
  assert.deepEqual([...v.map.keys()], ['andromeda-agent/device']);
  assert.deepEqual(await s.load(), c);
});

test('keyring: 1 281 caracteres vão em partes e voltam inteiros', async () => {
  const v = fakeVault();
  const s = new KeyringCredentialStore(v.factory);
  const c = credsOfLength(1281);
  await s.save(c);
  assert.equal(v.map.get('andromeda-agent/device'), 'parts:2');
  assert.ok(v.map.has('andromeda-agent/device.0') && v.map.has('andromeda-agent/device.1'));
  assert.deepEqual(await s.load(), c);
});

test('keyring: voltar a um valor pequeno apaga as partes; clear limpa tudo', async () => {
  const v = fakeVault();
  const s = new KeyringCredentialStore(v.factory);
  await s.save(credsOfLength(3000));
  assert.equal(v.map.size, 4);
  await s.save(makeCreds());
  assert.deepEqual([...v.map.keys()], ['andromeda-agent/device']);
  await s.save(credsOfLength(2600));
  await s.clear();
  assert.equal(v.map.size, 0);
  assert.equal(await s.load(), null);
});

test('defaultCredentialStore cai no arquivo se o cofre falhar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'andr-'));
  try {
    const broken: KeyringFactory = () => ({
      getPassword: () => {
        throw new Error('sem Secret Service');
      },
      setPassword: () => undefined,
      deletePassword: () => false,
    });
    assert.ok(defaultCredentialStore(dir, broken) instanceof FileCredentialStore);
    assert.ok(defaultCredentialStore(dir, fakeVault().factory) instanceof KeyringCredentialStore);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('arquivo: grava, lê, sobrescreve atomicamente (sem sobras) e limpa', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'andr-'));
  try {
    const s = new FileCredentialStore(join(dir, 'sub'), () => undefined);
    assert.equal(await s.load(), null);
    await s.save(makeCreds());
    const c2 = { ...makeCreds(), accessToken: 'novo' };
    await s.save(c2);
    assert.deepEqual(await s.load(), c2);
    assert.deepEqual(await readdir(join(dir, 'sub')), ['credentials.json']);
    if (process.platform !== 'win32') {
      assert.equal((await stat(s.path)).mode & 0o777, 0o600);
    }
    await s.clear();
    assert.equal(await s.load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('arquivo: conteúdo corrompido vira null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'andr-'));
  try {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(dir, 'credentials.json'), '{ não é json');
    assert.equal(await new FileCredentialStore(dir).load(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keyring real (opcional)', { skip: process.env.ANDROMEDA_TEST_KEYRING !== '1' }, async () => {
  const s = new KeyringCredentialStore();
  try {
    await s.save(credsOfLength(2000));
    assert.deepEqual(await s.load(), credsOfLength(2000));
  } finally {
    await s.clear();
  }
});
