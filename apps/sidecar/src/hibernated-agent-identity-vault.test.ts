// Exercises `hibernated-agent-identity-vault.ts` against the real,
// unmodified `@intx/hub-agent` key/repo stores -- the same technique
// `apps/sidecar/test/suspend-key-preservation.poc.test.ts` (PR #291)
// proved works, now against the actual snapshot/restore/reap module this
// repo ships.
import { describe, test, expect, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAgentKeyStore,
  createAgentRepoStore,
  agentDir,
} from "@intx/hub-agent";
import { generateKeyPair, signEd25519, verifySSHSignature } from "@intx/crypto";

import {
  snapshotAgentIdentity,
  restoreAgentIdentity,
  reapExpiredHibernationSnapshots,
} from "./hibernated-agent-identity-vault";

const cryptoOps = {
  generateKeyPair,
  signEd25519,
  verifySSHSig: verifySSHSignature,
};

async function makeTmpDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hibernated-agent-vault-"));
}

async function modeOf(target: string): Promise<number> {
  const stat = await fs.stat(target);
  return stat.mode & 0o777;
}

describe("hibernated-agent-identity-vault", () => {
  test("snapshot then restore preserves the real agent keypair with isNew: false", async () => {
    const dataDir = await makeTmpDataDir();
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const repoStore = createAgentRepoStore({ dataDir });
    const address = "run_hibernate-vault@example.com";

    const { keyPair: original } = await keyStore.loadOrGenerateKey(address);

    const snapshot = await snapshotAgentIdentity(dataDir, address);
    expect(snapshot.snapshotted).toBe(true);

    // The real, unmodified destructive call `hub-link.js` makes on every
    // undeploy -- exercised here exactly as the PR #291 spike exercised it.
    await repoStore.remove(address);
    expect(await fs.readdir(dataDir)).not.toContain(
      path.basename(agentDir(dataDir, address)),
    );

    const restore = await restoreAgentIdentity(dataDir, address);
    expect(restore.restored).toBe(true);

    const { keyPair: restored, isNew } =
      await keyStore.loadOrGenerateKey(address);
    expect(isNew).toBe(false);
    expect(restored.privateKey).toEqual(original.privateKey);
    expect(restored.publicKey).toEqual(original.publicKey);
  });

  test("no snapshot means the destructive remove wins -- a fresh keypair comes back", async () => {
    const dataDir = await makeTmpDataDir();
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const repoStore = createAgentRepoStore({ dataDir });
    const address = "run_no-snapshot@example.com";

    const { keyPair: original } = await keyStore.loadOrGenerateKey(address);

    // No snapshotAgentIdentity call: models the reclaimDirs: true (real
    // undeploy) path, which never protects the identity directory.
    await repoStore.remove(address);

    const restore = await restoreAgentIdentity(dataDir, address);
    expect(restore.restored).toBe(false);

    const { keyPair: regenerated, isNew } =
      await keyStore.loadOrGenerateKey(address);
    expect(isNew).toBe(true);
    expect(regenerated.privateKey).not.toEqual(original.privateKey);
  });

  test("the vault snapshot is hardened to owner-only permissions", async () => {
    const dataDir = await makeTmpDataDir();
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const address = "run_permissions@example.com";
    await keyStore.loadOrGenerateKey(address);

    await snapshotAgentIdentity(dataDir, address);

    const vaultEntry = path.join(
      dataDir,
      "hibernated-agent-identity",
      path.basename(agentDir(dataDir, address)),
    );
    expect(await modeOf(vaultEntry)).toBe(0o700);
    const keysDir = path.join(vaultEntry, "keys");
    expect(await modeOf(keysDir)).toBe(0o700);
    const privateKeyFile = path.join(keysDir, "id_ed25519");
    expect(await modeOf(privateKeyFile)).toBe(0o600);
  });

  test("a snapshot taken after the identity directory is already gone reports loudly and returns snapshotted: false", async () => {
    const dataDir = await makeTmpDataDir();
    const address = "run_already-gone@example.com";

    const reportErrorMock = mock(
      (_error: unknown, _context: unknown) => "ref-test",
    );
    mock.module("@corbits/error-sink", () => ({
      reportError: reportErrorMock,
    }));
    const { snapshotAgentIdentity: freshSnapshot } =
      await import("./hibernated-agent-identity-vault");

    const result = await freshSnapshot(dataDir, address);

    expect(result.snapshotted).toBe(false);
    expect(reportErrorMock).toHaveBeenCalledTimes(1);
    const context = reportErrorMock.mock.calls[0]?.[1];
    expect(context).toMatchObject({
      operation: "hibernated-agent-identity-vault.snapshot",
      agentId: address,
    });

    mock.restore();
  });

  test("reapExpiredHibernationSnapshots deletes only entries past retention", async () => {
    const dataDir = await makeTmpDataDir();
    const keyStoreOld = createAgentKeyStore({ dataDir, ...cryptoOps });
    const keyStoreFresh = createAgentKeyStore({ dataDir, ...cryptoOps });
    const oldAddress = "run_old-orphan@example.com";
    const freshAddress = "run_fresh-hibernate@example.com";
    const retentionMs = 1_000;

    await keyStoreOld.loadOrGenerateKey(oldAddress);
    await snapshotAgentIdentity(dataDir, oldAddress);
    // Backdate the orphan's marker past retention; a real orphan is one
    // nothing has redeployed (and thus restored) since it hibernated.
    const oldVaultEntry = path.join(
      dataDir,
      "hibernated-agent-identity",
      path.basename(agentDir(dataDir, oldAddress)),
    );
    await fs.writeFile(
      path.join(oldVaultEntry, ".snapshotted-at"),
      new Date(Date.now() - retentionMs - 1).toISOString(),
      { mode: 0o600 },
    );

    await keyStoreFresh.loadOrGenerateKey(freshAddress);
    await snapshotAgentIdentity(dataDir, freshAddress);

    const result = await reapExpiredHibernationSnapshots(dataDir, {
      retentionMs,
    });

    expect(result.reapedEntries).toEqual([
      path.basename(agentDir(dataDir, oldAddress)),
    ]);
    await expect(fs.stat(oldVaultEntry)).rejects.toThrow();
    const freshVaultEntry = path.join(
      dataDir,
      "hibernated-agent-identity",
      path.basename(agentDir(dataDir, freshAddress)),
    );
    await expect(fs.stat(freshVaultEntry)).resolves.toBeDefined();
  });

  test("reapExpiredHibernationSnapshots on a vault-less data dir is a no-op", async () => {
    const dataDir = await makeTmpDataDir();
    const result = await reapExpiredHibernationSnapshots(dataDir);
    expect(result.reapedEntries).toEqual([]);
  });
});
