// Capability-add is a read-modify-write of the definition's asset: two
// concurrent POSTs that both snapshot the same workflow.json and then
// each write their own pin would last-write-wins clobber the other
// (CL-7216). This module owns that RMW so both the tenant-session route
// and the workflow-run route retry the loser against the latest snapshot
// instead of silently dropping an add.

import type { PinnedSkillIndexEntry } from "@corbits/skills";
import type { AssetService } from "@intx/hub-sessions";

import {
  readAgentCapabilities,
  reindexPinnedSkills,
  withAgentModel,
  withAgentToolPackagePin,
} from "./agent-workflow";
import type { AddCapabilityInput } from "./capability-inventory";
import {
  readAgentDefinitionWorkflowJson,
  writeAndDeployAgentDefinition,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import type { DefinitionSkillsStore } from "./skills-store";

const MAX_STALE_SNAPSHOT_RETRIES = 8;

const writeChains = new Map<string, Promise<void>>();

async function withAssetWriteLock<T>(
  assetId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = writeChains.get(assetId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeChains.set(
    assetId,
    previous.then(() => held),
  );
  try {
    await previous;
    return await fn();
  } finally {
    release();
  }
}

export type CommitAgentCapabilityAddArgs = {
  assetService: AssetService;
  deployer: AgentDefinitionDeployer;
  skillsStore: DefinitionSkillsStore;
  skillIndex: {
    resolve(
      tenantId: string,
      principalId: string,
      names: readonly string[],
    ): Promise<readonly PinnedSkillIndexEntry[]>;
  };
  tenantId: string;
  principalId: string;
  assetId: string;
  handle: string;
  body: AddCapabilityInput;
};

export type CommitAgentCapabilityAddResult = {
  toolPackagePins: ReturnType<typeof readAgentCapabilities>["toolPackagePins"];
  skills: readonly string[];
  model?: string;
};

/**
 * Applies one capability add against the definition's current asset,
 * retrying when a concurrent writer moved the snapshot between this
 * call's read and its write. The per-asset lock makes that stale check
 * atomic so the loser reapplies on the winner's tree instead of
 * clobbering it.
 */
export async function commitAgentCapabilityAdd(
  args: CommitAgentCapabilityAddArgs,
): Promise<CommitAgentCapabilityAddResult> {
  for (
    let remaining = MAX_STALE_SNAPSHOT_RETRIES;
    remaining > 0;
    remaining -= 1
  ) {
    const snapshot = await readAgentDefinitionWorkflowJson(
      args.assetService,
      args.assetId,
    );
    const prepared = await prepareCapabilityAdd(snapshot, args);
    const wrote = await withAssetWriteLock(args.assetId, async () => {
      const latest = await readAgentDefinitionWorkflowJson(
        args.assetService,
        args.assetId,
      );
      if (latest !== snapshot) return false;
      await writeAndDeployAgentDefinition({
        assetService: args.assetService,
        deployer: args.deployer,
        tenantId: args.tenantId,
        principalId: args.principalId,
        assetId: args.assetId,
        handle: args.handle,
        workflowJson: prepared.workflowJson,
        message: prepared.message,
      });
      if (prepared.nextSkills !== null) {
        await args.skillsStore.setSkills(args.assetId, prepared.nextSkills);
      }
      return true;
    });
    if (wrote) return prepared.result;
  }
  throw new Error(
    `capability add for asset ${args.assetId} conflicted after ${String(MAX_STALE_SNAPSHOT_RETRIES)} retries`,
  );
}

type PreparedCapabilityAdd = {
  workflowJson: string;
  message: string;
  nextSkills: readonly string[] | null;
  result: CommitAgentCapabilityAddResult;
};

async function prepareCapabilityAdd(
  workflowJson: string,
  args: CommitAgentCapabilityAddArgs,
): Promise<PreparedCapabilityAdd> {
  let nextWorkflowJson: string;
  let message: string;
  let skills = await args.skillsStore.getSkills(args.assetId);
  let nextSkills: readonly string[] | null = null;

  switch (args.body.kind) {
    case "toolPackage": {
      nextWorkflowJson = withAgentToolPackagePin(workflowJson, {
        name: args.body.name,
        version: "*",
      });
      message = `Add ${args.body.name} to ${args.handle}`;
      break;
    }
    case "skill": {
      nextSkills = skills.includes(args.body.name)
        ? skills
        : [...skills, args.body.name];
      nextWorkflowJson = reindexPinnedSkills(
        workflowJson,
        await args.skillIndex.resolve(
          args.tenantId,
          args.principalId,
          nextSkills,
        ),
      );
      skills = nextSkills;
      message = `Add ${args.body.name} skill to ${args.handle}`;
      break;
    }
    case "model": {
      nextWorkflowJson = withAgentModel(workflowJson, args.body.canonicalName);
      message = `Set ${args.handle}'s model to ${args.body.canonicalName}`;
      break;
    }
  }

  const capabilities = readAgentCapabilities(nextWorkflowJson);
  return {
    workflowJson: nextWorkflowJson,
    message,
    nextSkills,
    result: {
      toolPackagePins: capabilities.toolPackagePins,
      skills,
      ...(capabilities.model !== undefined
        ? { model: capabilities.model }
        : {}),
    },
  };
}
