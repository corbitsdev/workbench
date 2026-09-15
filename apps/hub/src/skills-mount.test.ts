// Covers the `pinnedBy` resolver `mountSkills` hands the skill registry:
// every definition's pins are read out of its own asset snapshot, so one
// unreadable asset (a pre-cutover retired envelope, a missing blob) skips
// its row — reported, never failing the whole resolve — and the fan-out
// stays bounded no matter how many definitions a tenant carries.
import { expect, test } from "bun:test";

import type { DB } from "@intx/db";
import type { AssetService, RepoStore } from "@intx/hub-sessions";
import {
  agentDefinitionSourceTree,
  AGENT_DEFINITION_ENTRY_PATH,
  buildAgentDefinitionWorkflow,
  reindexPinnedSkills,
  RetiredWorkflowEnvelopeError,
  serializeAgentDefinitionWorkflow,
} from "@corbits/agent-directory";

import { mountSkills } from "./skills-mount";

/** Entry-module bytes pinning `names` — the stanza `pinnedBy` reads. */
function definitionBytesPinning(...names: string[]): Uint8Array {
  const tree = agentDefinitionSourceTree({
    handle: "research-buddy",
    workflowJson: reindexPinnedSkills(
      serializeAgentDefinitionWorkflow(
        buildAgentDefinitionWorkflow({
          handle: "research-buddy",
          tenantDomain: "acme.example",
          description: "",
          systemPrompt: "You are a careful research assistant.",
        }),
      ),
      names.map((name) => ({ name, description: `What ${name} does.` })),
    ),
  });
  return new TextEncoder().encode(tree[AGENT_DEFINITION_ENTRY_PATH]);
}

function mountFor(
  rows: readonly {
    id: string;
    tenantId: string;
    assetId: string | null;
    name: string;
  }[],
  readAssetBlob: AssetService["readAssetBlob"],
) {
  const db = {
    query: {
      workflowDefinition: { findMany: async () => rows },
    },
  } as unknown as DB["db"];
  return mountSkills({
    db,
    assetService: { readAssetBlob } as AssetService,
    repoStore: {} as RepoStore,
  });
}

test("a row on the retired envelope skips while healthy rows still resolve", async () => {
  const mount = mountFor(
    [
      {
        id: "def_healthy",
        tenantId: "tnt_1",
        assetId: "ast_healthy",
        name: "research-buddy",
      },
      {
        id: "def_retired",
        tenantId: "tnt_1",
        assetId: "ast_retired",
        name: "old-scout",
      },
    ],
    (params) =>
      params.assetId === "ast_healthy"
        ? Promise.resolve(definitionBytesPinning("research"))
        : Promise.reject(new RetiredWorkflowEnvelopeError(params.assetId)),
  );
  const pinning = await mount.pinnedBy.resolve("tnt_1", "research");
  expect(pinning).toEqual([
    { definitionId: "def_healthy", name: "research-buddy" },
  ]);
});

test("the blob fan-out stays bounded no matter how many definitions pin", async () => {
  const COUNT = 20;
  const rows = Array.from({ length: COUNT }, (_, index) => ({
    id: `def_${index}`,
    tenantId: "tnt_1",
    assetId: `ast_${index}`,
    name: `buddy-${index}`,
  }));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const mount = mountFor(rows, async () => {
    active += 1;
    peak = Math.max(peak, active);
    try {
      await gate;
      return definitionBytesPinning("research");
    } finally {
      active -= 1;
    }
  });
  const pending = mount.pinnedBy.resolve("tnt_1", "research");
  // Every worker reaches the gate before any read can finish, so the
  // peak observed here is the whole fan-out.
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(peak).toBeLessThanOrEqual(8);
  release();
  const pinning = await pending;
  expect(pinning).toHaveLength(COUNT);
});
