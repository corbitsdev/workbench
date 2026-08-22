// Spike PoC for CL-6581 / CL-6239: proves a suspend teardown can preserve an
// agent's Ed25519 signing identity WITHOUT vendoring `@intx/hub-agent`.
//
// Background: `@intx/hub-agent`'s `AgentKeyStore` persists each agent's
// reconnect-challenge keypair under `agentDir(dataDir, address)/keys/`
// (`agent-key-store.ts`). Its `AgentRepoStore.remove` -- reached from every
// `sendAgentUndeploy`, hibernate or not, via `session-manager.js`'s
// `deleteAgentDir` -- unconditionally `fsp.rm`s the whole `agentDir`,
// destroying the key subdirectory with it. That code lives entirely inside
// the published npm package (this repo carries no `vendor/intx/hub-agent`
// tree), so it cannot be edited directly.
//
// This test shows the fix does not require editing it: `agentDir(dataDir,
// address)` is a stable PUBLIC export (`@intx/hub-agent`'s `index.ts`), so a
// caller that snapshots the directory before the destructive `remove()` and
// restores it before the next `deploy` sees the *same* keypair come back out
// of `loadOrGenerateKey` -- `isNew: false` -- with no fork of the package.
//
// This file is a standalone PoC, not production wiring: it exercises
// `@intx/hub-agent`'s real, unmodified `createAgentKeyStore` /
// `createAgentRepoStore` / `agentDir` directly against a tmp dir. Wiring the
// same snapshot/restore into `workflow-host-wiring`'s `reclaimDirs`-aware
// `undeploy`/`deploy` hooks is the actual feature build, owned by a
// different lane.

import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAgentKeyStore,
  createAgentRepoStore,
  agentDir,
} from "@intx/hub-agent";
import {
  generateKeyPair,
  signEd25519,
  verifySSHSignature,
} from "@intx/crypto";

const cryptoOps = {
  generateKeyPair,
  signEd25519,
  verifySSHSig: verifySSHSignature,
};

async function makeTmpDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "hub-agent-suspend-poc-"));
}

describe("suspend key preservation without vendoring @intx/hub-agent", () => {
  test("an unprotected undeploy destroys the agent's keypair (establishes the baseline bug)", async () => {
    const dataDir = await makeTmpDataDir();
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const repoStore = createAgentRepoStore({ dataDir });
    const address = "run_baseline@example.com";

    const { keyPair: minted } = await keyStore.loadOrGenerateKey(address);
    expect(minted.privateKey.length).toBe(32);

    // The exact call `session-manager.js`'s `deleteAgentDir` makes from
    // `hub-link.js`'s `handleAgentUndeploy`, unconditionally, on every
    // `sendAgentUndeploy` -- hibernate reason or not.
    await repoStore.remove(address);

    expect(await fs.readdir(dataDir)).toEqual([]);

    const freshKeyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const { keyPair: regenerated, isNew } =
      await freshKeyStore.loadOrGenerateKey(address);
    expect(isNew).toBe(true);
    expect(regenerated.privateKey).not.toEqual(minted.privateKey);
  });

  test("snapshot-before-remove + restore-before-redeploy preserves identity across the same destructive call", async () => {
    const dataDir = await makeTmpDataDir();
    const vaultDir = await makeTmpDataDir();
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const repoStore = createAgentRepoStore({ dataDir });
    const address = "run_hibernate@example.com";

    const { keyPair: original } = await keyStore.loadOrGenerateKey(address);

    // -- workbench-owned "undeploy" hook, gated on
    // `reason === IDLE_HIBERNATE_UNDEPLOY_REASON` in the real wiring --
    // snapshots the whole agent directory via the public `agentDir` export
    // before the package's own teardown deletes it.
    const dir = agentDir(dataDir, address);
    const vaultEntry = path.join(vaultDir, path.basename(dir));
    await fs.cp(dir, vaultEntry, { recursive: true });

    // The real, unmodified destructive call.
    await repoStore.remove(address);
    keyStore.forgetAgent(address);
    expect(await fs.readdir(dataDir)).toEqual([]);

    // -- workbench-owned "deploy" hook, run before the redeploy reaches
    // `loadOrGenerateKey` -- restores the snapshot.
    await fs.cp(vaultEntry, dir, { recursive: true });
    await fs.rm(vaultEntry, { recursive: true });

    const { keyPair: restored, isNew } =
      await keyStore.loadOrGenerateKey(address);
    expect(isNew).toBe(false);
    expect(restored.privateKey).toEqual(original.privateKey);
    expect(restored.publicKey).toEqual(original.publicKey);
  });
});
