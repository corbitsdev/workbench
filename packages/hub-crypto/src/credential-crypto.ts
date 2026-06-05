import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Format: "1:<key>,2:<key>" — key may be hex (64 chars) or base64 (44 chars for 32 bytes).
// Highest version number is active for new encrypts.
// All versions are retained for decryption to support key rotation without downtime.

const ENC_PREFIX = 'enc:';
const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

export type CredentialKeyEntry = { version: number; key: Buffer };

export type CredentialKeyRegistry = {
  active: CredentialKeyEntry;
  all: Map<number, Buffer>;
};

export function parseEncryptionKeys(raw: string): CredentialKeyRegistry {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const all = new Map<number, Buffer>();

  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(
        `Invalid CREDENTIAL_ENCRYPTION_KEYS entry "${entry}": expected "version:key" (hex or base64)`
      );
    }

    const versionStr = entry.slice(0, colonIdx).trim();
    const version = Number(versionStr);
    if (!Number.isFinite(version) || version <= 0 || versionStr !== String(version)) {
      throw new Error(
        `Invalid CREDENTIAL_ENCRYPTION_KEYS entry "${entry}": version must be a positive integer`
      );
    }

    const keyStr = entry.slice(colonIdx + 1).trim();
    const encoding = /^[0-9a-fA-F]{64}$/.test(keyStr) ? 'hex' : 'base64';
    const key = Buffer.from(keyStr, encoding);
    if (key.length !== KEY_LEN) {
      throw new Error(
        `Invalid CREDENTIAL_ENCRYPTION_KEYS entry "${entry}": key must decode to ${KEY_LEN} bytes — provide a 64-char hex string or a 44-char base64 string, got ${key.length} bytes`
      );
    }

    all.set(version, key);
  }

  if (all.size === 0) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEYS is empty or contains no valid entries');
  }

  const maxVersion = Math.max(...all.keys());
  return { active: { version: maxVersion, key: all.get(maxVersion)! }, all };
}

function deriveKey(masterKey: Buffer, tenantId: string): Buffer {
  // Empty salt is valid per RFC 5869 §2.2 — HKDF substitutes a HashLen-length zeroed string.
  // Domain separation between tenants is provided by the tenantId info parameter.
  return Buffer.from(hkdfSync('sha256', masterKey, '', tenantId, KEY_LEN));
}

export function encryptSecret(
  keys: CredentialKeyRegistry,
  tenantId: string,
  plaintext: string
): string {
  if (plaintext.startsWith(ENC_PREFIX)) {
    throw new Error('encryptSecret called on an already-encrypted value');
  }

  const { version, key } = keys.active;
  const derivedKey = deriveKey(key, tenantId);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, derivedKey, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, encrypted]);

  return `${ENC_PREFIX}v${version}:${payload.toString('base64')}`;
}

export function decryptSecret(
  keys: CredentialKeyRegistry,
  tenantId: string,
  ciphertext: string
): string {
  if (!ciphertext.startsWith(ENC_PREFIX)) {
    throw new Error('decryptSecret called on value without enc: prefix');
  }

  const rest = ciphertext.slice(ENC_PREFIX.length);
  const vMatch = rest.match(/^v(\d+):/);
  if (!vMatch) {
    throw new Error('Invalid enc: format — missing version prefix (expected enc:vN:...)');
  }

  const version = Number(vMatch[1]);
  const key = keys.all.get(version);
  if (!key) {
    throw new Error(`No encryption key registered for version ${version}`);
  }

  const payload = Buffer.from(rest.slice(vMatch[0].length), 'base64');
  const iv = payload.subarray(0, IV_LEN);
  const tag = payload.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = payload.subarray(IV_LEN + TAG_LEN);

  const derivedKey = deriveKey(key, tenantId);
  const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
