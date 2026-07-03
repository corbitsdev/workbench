import { describe, it, expect, mock, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tiny thresholds so a handful of commits crosses the loose-object trigger.
const TEST_AGENT_GC = {
  packThreshold: 999,
  looseThreshold: 4,
  warnBytes: 1024 * 1024 * 1024,
};

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "myra-title-gc-"));

mock.module("../config", () => ({
  getConfig: () => ({
    hub: { dataDir, agentGc: TEST_AGENT_GC },
    rootTenant: { slug: "global", domain: "global.test" },
  }),
}));

import { titleStoreGcPolicy } from "./myra-threads";
import {
  createIsogitStore,
  countLooseObjects,
  countPackFiles,
} from "@workbench/storage-isogit";

afterAll(async () => {
  await fs.promises.rm(dataDir, { recursive: true, force: true });
});

describe("titleStoreGcPolicy (CL-2663)", () => {
  it("derives the write-path policy from hub.agentGc with keep-history retention", () => {
    expect(titleStoreGcPolicy()).toEqual({
      ...TEST_AGENT_GC,
      retention: "keep-history",
    });
  });

  it("reclaims the title repo on the write path once commits cross looseThreshold, keeping history", async () => {
    const repoDir = path.join(dataDir, "myra-title", "tn-1", "prn-1");
    const store = await createIsogitStore(
      repoDir,
      undefined,
      titleStoreGcPolicy(),
    );

    const commits = 6;
    for (let i = 0; i < commits; i += 1) {
      await store.writeBlob(
        `call-${String(i)}`,
        new TextEncoder().encode(`title audit payload ${String(i)}`),
        "text/plain",
      );
      await store.commit({ message: `title turn ${String(i)}` });
    }

    // Crossing looseThreshold must have consolidated loose objects into a pack.
    expect(countPackFiles(repoDir)).toBeGreaterThanOrEqual(1);
    expect(countLooseObjects(repoDir)).toBeLessThan(
      TEST_AGENT_GC.looseThreshold,
    );

    // keep-history: the reclaim must not drop the audit ancestry (the +1 is
    // initAgentRepo's initial commit).
    const log = await store.log(commits + 2);
    expect(log.length).toBe(commits + 1);
  });
});
