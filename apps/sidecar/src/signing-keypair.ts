import fs from "node:fs/promises";
import path from "node:path";
import { derivePublicKeyBytes, generateKeyPair } from "@intx/crypto";
import type { KeyPair } from "@intx/types/runtime";

const PRIVATE_KEY_FILENAME = "ed25519.private";
const PUBLIC_KEY_FILENAME = "ed25519.public";

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The seed file is the sole source of identity; the public file is cross
 * checked against it on every load, not trusted as a cache, so a corrupted
 * or swapped file fails loud at boot instead of silently failing signature
 * verification at the hub later.
 */
export async function loadOrMintSidecarKeypair(signingDir: string): Promise<KeyPair> {
  const privateKeyPath = path.join(signingDir, PRIVATE_KEY_FILENAME);
  const publicKeyPath = path.join(signingDir, PUBLIC_KEY_FILENAME);

  const [havePriv, havePub] = await Promise.all([exists(privateKeyPath), exists(publicKeyPath)]);
  if (havePriv !== havePub) {
    throw new Error(
      `sidecar signing keypair under ${signingDir} is partial: privateKey=${String(havePriv)} publicKey=${String(havePub)}; remove the directory to reset`,
    );
  }
  if (havePriv && havePub) {
    const [priv, pub] = await Promise.all([
      fs.readFile(privateKeyPath),
      fs.readFile(publicKeyPath),
    ]);
    const seed = new Uint8Array(priv);
    const storedPublicKey = new Uint8Array(pub);
    let derivedPublicKey: Uint8Array;
    try {
      derivedPublicKey = await derivePublicKeyBytes(seed);
    } catch (cause) {
      throw new Error(
        `sidecar signing seed at ${privateKeyPath} is not a valid Ed25519 seed; remove ${signingDir} to reset`,
        { cause },
      );
    }
    if (!bytesEqual(derivedPublicKey, storedPublicKey)) {
      throw new Error(
        `sidecar signing public key at ${publicKeyPath} does not match the key derived from the seed at ${privateKeyPath}; the sidecar would advertise a public key it cannot sign with, so every signature would fail verification at the hub; restore the matching seed, or remove ${signingDir} to mint a fresh identity`,
      );
    }
    return { privateKey: seed, publicKey: derivedPublicKey };
  }

  const keyPair = await generateKeyPair();
  await fs.mkdir(signingDir, { recursive: true });
  await Promise.all([
    fs.writeFile(privateKeyPath, keyPair.privateKey, { mode: 0o600 }),
    fs.writeFile(publicKeyPath, keyPair.publicKey),
  ]);
  return keyPair;
}
