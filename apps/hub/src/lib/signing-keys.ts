// Versioned Ed25519 signing key registry for the hub.
//
// Keys are loaded from the HUB_SIGNING_KEYS env var only. No disk persistence.
// Format: version:hex64,version:hex64 (highest version = active)
//
// The active key signs new deploy commits. All trusted keys verify old commits.

import { importPrivateKeyBytes } from '@intx/crypto-node';
import { createPublicKey } from 'node:crypto';

export type SigningKeyEntry = {
  version: number;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
};

export type SigningKeyRegistry = {
  active: SigningKeyEntry;
  all: Map<number, SigningKeyEntry>;
  getPublicKeyHex(version: number): string | null;
};

export function parseSigningKeys(raw: string): SigningKeyRegistry {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const all = new Map<number, SigningKeyEntry>();

  for (const entry of entries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Invalid HUB_SIGNING_KEYS entry "${entry}": expected "version:hexKey"`);
    }

    const versionStr = entry.slice(0, colonIdx).trim();
    const hexKey = entry.slice(colonIdx + 1).trim();

    const version = Number(versionStr);
    if (!Number.isFinite(version) || version <= 0 || versionStr !== String(version)) {
      throw new Error(
        `Invalid HUB_SIGNING_KEYS entry "${entry}": version must be a positive integer`
      );
    }

    if (hexKey.length !== 64) {
      throw new Error(
        `Invalid HUB_SIGNING_KEYS entry "${entry}": key must be 64 hex characters, got ${hexKey.length}`
      );
    }

    const rawBytes = Buffer.from(hexKey, 'hex');
    if (rawBytes.length !== 32) {
      throw new Error(
        `Invalid HUB_SIGNING_KEYS entry "${entry}": decoded key must be 32 bytes, got ${rawBytes.length}`
      );
    }

    const privateKey = new Uint8Array(rawBytes);
    const privateKeyObj = importPrivateKeyBytes(privateKey);
    const publicKeyObj = createPublicKey(privateKeyObj);
    const spkiDer = publicKeyObj.export({ type: 'spki', format: 'der' }) as Buffer;
    const publicKey = new Uint8Array(spkiDer.buffer, spkiDer.byteOffset + spkiDer.length - 32, 32);

    all.set(version, { version, privateKey, publicKey });
  }

  if (all.size === 0) {
    throw new Error('HUB_SIGNING_KEYS env var is empty or contains no valid entries');
  }

  const maxVersion = Math.max(...all.keys());
  const active = all.get(maxVersion)!;

  return {
    active,
    all,
    getPublicKeyHex(version: number): string | null {
      const entry = all.get(version);
      if (!entry) return null;
      return Buffer.from(entry.publicKey).toString('hex');
    },
  };
}

export function loadSigningKeyRegistry(raw: string): SigningKeyRegistry {
  return parseSigningKeys(raw);
}
