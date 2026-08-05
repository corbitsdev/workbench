import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";
import { loadOrMintSidecarKeypair } from "../src/signing-keypair";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeSigningDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sidecar-signing-"));
  tempDirs.push(dir);
  return path.join(dir, ".sidecar-signing");
}

test("mints and persists a keypair on first boot", async () => {
  const signingDir = await makeSigningDir();
  const keyPair = await loadOrMintSidecarKeypair(signingDir);
  expect(keyPair.privateKey.length).toBe(32);
  expect(keyPair.publicKey.length).toBe(32);
  const persisted = await readFile(path.join(signingDir, "ed25519.private"));
  expect(new Uint8Array(persisted)).toEqual(new Uint8Array(keyPair.privateKey));
});

test("loads the same identity on a second boot", async () => {
  const signingDir = await makeSigningDir();
  const first = await loadOrMintSidecarKeypair(signingDir);
  const second = await loadOrMintSidecarKeypair(signingDir);
  expect(second.publicKey).toEqual(first.publicKey);
  expect(second.privateKey).toEqual(first.privateKey);
});

test("halts when the public anchor does not match the seed", async () => {
  const signingDir = await makeSigningDir();
  await loadOrMintSidecarKeypair(signingDir);
  await writeFile(
    path.join(signingDir, "ed25519.public"),
    new Uint8Array(32).fill(7),
  );
  await expect(loadOrMintSidecarKeypair(signingDir)).rejects.toThrow(
    /does not match/,
  );
});

test("halts on a partial keypair directory", async () => {
  const signingDir = await makeSigningDir();
  await loadOrMintSidecarKeypair(signingDir);
  await rm(path.join(signingDir, "ed25519.public"));
  await expect(loadOrMintSidecarKeypair(signingDir)).rejects.toThrow(/partial/);
});
