import { describe, expect, it } from 'bun:test';
import { decryptSecret, encryptSecret, parseEncryptionKeys } from './credential-crypto';

const KEY_V1 = `1:${Buffer.alloc(32, 0x01).toString('base64')}`;
const KEY_V2 = `2:${Buffer.alloc(32, 0x02).toString('base64')}`;

const keysV1 = parseEncryptionKeys(KEY_V1);
const keysV1V2 = parseEncryptionKeys(`${KEY_V1},${KEY_V2}`);

const TENANT_A = 'tenant_aaa';
const TENANT_B = 'tenant_bbb';

describe('parseEncryptionKeys', () => {
  it('selects the highest version as active', () => {
    expect(keysV1V2.active.version).toBe(2);
  });

  it('rejects entries without a colon', () => {
    expect(() => parseEncryptionKeys('bad')).toThrow();
  });

  it('rejects keys that are not 32 bytes after base64 decode', () => {
    expect(() => parseEncryptionKeys('1:dG9vc2hvcnQ=')).toThrow();
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a secret', () => {
    const encrypted = encryptSecret(keysV1, TENANT_A, 'sk-test-key');
    expect(decryptSecret(keysV1, TENANT_A, encrypted)).toBe('sk-test-key');
  });

  it('encrypted value carries enc:v1: prefix', () => {
    const encrypted = encryptSecret(keysV1, TENANT_A, 'sk-test-key');
    expect(encrypted.startsWith('enc:v1:')).toBe(true);
  });

  it('different tenants produce different ciphertexts', () => {
    const a = encryptSecret(keysV1, TENANT_A, 'same-secret');
    const b = encryptSecret(keysV1, TENANT_B, 'same-secret');
    expect(a).not.toBe(b);
  });

  it('tenant A cannot decrypt tenant B ciphertext', () => {
    const encrypted = encryptSecret(keysV1, TENANT_B, 'secret');
    expect(() => decryptSecret(keysV1, TENANT_A, encrypted)).toThrow();
  });

  it('decryptSecret rejects a plaintext value (no enc: prefix)', () => {
    expect(() => decryptSecret(keysV1, TENANT_A, 'plaintext-no-prefix')).toThrow();
  });

  it('encryptSecret throws on already-encrypted input', () => {
    const encrypted = encryptSecret(keysV1, TENANT_A, 'sk-key');
    expect(() => encryptSecret(keysV1, TENANT_A, encrypted)).toThrow();
  });

  it('round-trips a secret containing multi-byte UTF-8 characters', () => {
    const secret = 'sk-tëst-ké¥-🔑';
    expect(decryptSecret(keysV1, TENANT_A, encryptSecret(keysV1, TENANT_A, secret))).toBe(secret);
  });

  it('decrypts ciphertext encrypted with an older key version after rotation', () => {
    const oldCiphertext = encryptSecret(keysV1, TENANT_A, 'sk-legacy');
    // keysV1V2 has v2 active but retains v1 for decryption
    expect(decryptSecret(keysV1V2, TENANT_A, oldCiphertext)).toBe('sk-legacy');
  });

  it('new encrypts after rotation use the active (highest) key version', () => {
    const encrypted = encryptSecret(keysV1V2, TENANT_A, 'sk-new');
    expect(encrypted.startsWith('enc:v2:')).toBe(true);
    expect(decryptSecret(keysV1V2, TENANT_A, encrypted)).toBe('sk-new');
  });

  it('decryptSecret throws when the key version is not in the registry', () => {
    const encrypted = encryptSecret(keysV1V2, TENANT_A, 'sk-new'); // enc:v2:...
    expect(() => decryptSecret(keysV1, TENANT_A, encrypted)).toThrow(); // keysV1 has no v2
  });
});
