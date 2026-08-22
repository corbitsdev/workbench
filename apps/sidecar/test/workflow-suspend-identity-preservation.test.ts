// End-to-end proof that the real `createSidecarDeployRouter` wiring --
// not just the standalone `hibernated-agent-identity-vault.ts` module --
// preserves an agent's reconnect-challenge keypair across a
// state-preserving "hibernate" teardown (reclaimDirs: false), and still
// lets a reclaiming (non-hibernate) teardown destroy it. Uses a REAL
// `@intx/hub-agent` key store bound to the fixture's data dir (via
// `makeLifecycleFixture`'s `keyStore` override) rather than the shared
// fixture's default in-memory fake, which never touches disk and so
// cannot exercise this path.
import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createAgentKeyStore,
  createAgentRepoStore,
  agentDir,
} from "@intx/hub-agent";
import { generateKeyPair, signEd25519, verifySSHSignature } from "@intx/crypto";
import { hexEncode } from "@intx/types";

import {
  answerReadyHandshake,
  makeLifecycleFixture,
  makeWorkflowFrame,
} from "./support/workflow-lifecycle-fixture";

const cryptoOps = {
  generateKeyPair,
  signEd25519,
  verifySSHSig: verifySSHSignature,
};

// `makeWorkflowFrame`'s default `hubPublicKey` ("hub-pk") is a placeholder
// the shared fixture's FAKE key store never validates. The real
// `AgentKeyStore.recordHubKey` this suite exercises hex-decodes it, so
// every frame here carries a real hex-encoded key instead.
async function makeFrameWithRealHubKey(agentAddress: string) {
  const hubKeyPair = await generateKeyPair();
  return {
    ...makeWorkflowFrame(agentAddress),
    hubPublicKey: hexEncode(hubKeyPair.publicKey),
  };
}

describe("hibernate/wake preserves the real deployed agent's identity", () => {
  test("hibernate teardown, then redeploy: the same keypair comes back (isNew: false)", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "sidecar-suspend-identity-"),
    );
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    // The real, unmodified package's own repo store -- its `remove` is
    // exactly the destructive call `@intx/hub-agent`'s `ws/hub-link.js`
    // issues AFTER our `undeploy` hook returns for every undeploy,
    // hibernate or not.
    const realRepoStore = createAgentRepoStore({ dataDir });

    const { router, spawns } = await makeLifecycleFixture({
      dataDir,
      keyStore,
    });
    const address = "run_suspend-hibernate@example.com";

    const frame1 = await makeFrameWithRealHubKey(address);
    const deploy1 = router.deploy(frame1);
    await answerReadyHandshake(spawns, 0);
    await deploy1;

    const { keyPair: original } = await keyStore.loadOrGenerateKey(address);

    await router.teardownDeployment(address, { reclaimDirs: false });
    // Models the published package's own post-hook delete.
    await realRepoStore.remove(address);
    expect(await fs.readdir(dataDir)).not.toContain(
      path.basename(agentDir(dataDir, address)),
    );

    const frame2 = await makeFrameWithRealHubKey(address);
    const deploy2 = router.deploy(frame2);
    await answerReadyHandshake(spawns, 1);
    await deploy2;

    // The real proof: deploy2's redeploy loaded back the SAME key bytes
    // `original` held before the hibernate teardown + destructive remove,
    // not a freshly minted keypair.
    const { keyPair: restored } = await keyStore.loadOrGenerateKey(address);
    expect(restored.privateKey).toEqual(original.privateKey);
    expect(restored.publicKey).toEqual(original.publicKey);
  });

  test("reclaiming (non-hibernate) teardown, then redeploy: a fresh keypair comes back", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "sidecar-suspend-identity-"),
    );
    const keyStore = createAgentKeyStore({ dataDir, ...cryptoOps });
    const realRepoStore = createAgentRepoStore({ dataDir });

    const { router, spawns } = await makeLifecycleFixture({
      dataDir,
      keyStore,
    });
    const address = "run_suspend-reclaim@example.com";

    const frame1 = await makeFrameWithRealHubKey(address);
    const deploy1 = router.deploy(frame1);
    await answerReadyHandshake(spawns, 0);
    await deploy1;

    const { keyPair: original } = await keyStore.loadOrGenerateKey(address);

    await router.teardownDeployment(address, { reclaimDirs: true });
    await realRepoStore.remove(address);

    const frame2 = await makeFrameWithRealHubKey(address);
    const deploy2 = router.deploy(frame2);
    await answerReadyHandshake(spawns, 1);
    await deploy2;

    // A THIRD `loadOrGenerateKey` call for the same address always reads
    // back `isNew: false` regardless of whether deploy2's own internal
    // call (inside `spawnWorkflowDeployment`) minted a fresh key or
    // restored an old one -- some key now exists on disk either way, so
    // `isNew` here would not distinguish the two. The actual proof is the
    // key material itself: a destructive (reclaimDirs: true) teardown
    // must leave deploy2 minting a DIFFERENT keypair than `original`.
    const { keyPair: regenerated } = await keyStore.loadOrGenerateKey(address);
    expect(regenerated.privateKey).not.toEqual(original.privateKey);
    expect(regenerated.publicKey).not.toEqual(original.publicKey);
  });
});
