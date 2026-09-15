// Capability-add is a read-modify-write of the definition's asset: two
// concurrent POSTs that both snapshot the same workflow.json and then
// each write their own pin would last-write-wins clobber the other
// (CL-7216). This module owns that mutation so both the tenant-session
// route and the workflow-run route retry the loser against the latest
// snapshot instead of silently dropping an add. The lock itself lives
// in `./asset-write.ts` so sibling RMW routes share it.

import type { PinnedSkillIndexEntry } from "@corbits/skills";
import type { DB } from "@intx/db";
import type { AssetService } from "@intx/hub-sessions";

import {
  readAgentCapabilities,
  readPinnedSkillNames,
  reindexPinnedSkills,
  withAgentModel,
  withAgentToolPackagePin,
} from "./agent-workflow";
import { commitLatestAgentAssetSnapshot } from "./asset-write";
import type { AddCapabilityInput } from "./capability-inventory";
import {
  writeAndDeployAgentDefinition,
  type AgentDefinitionDeployer,
} from "./definition-asset";
import { resolvePinnedVersion } from "./tool-package-version";

export type CommitAgentCapabilityAddArgs = {
  db: DB["db"];
  assetService: AssetService;
  deployer: AgentDefinitionDeployer;
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
  return commitLatestAgentAssetSnapshot({
    assetService: args.assetService,
    assetId: args.assetId,
    operation: "capability add",
    prepare: async (snapshot) => {
      const prepared = await prepareCapabilityAdd(snapshot, args);
      return {
        workflowJson: prepared.workflowJson,
        message: prepared.message,
        result: prepared.result,
      };
    },
    write: async ({ workflowJson, message }) => {
      await writeAndDeployAgentDefinition({
        assetService: args.assetService,
        deployer: args.deployer,
        tenantId: args.tenantId,
        principalId: args.principalId,
        assetId: args.assetId,
        handle: args.handle,
        workflowJson,
        message,
      });
    },
  });
}

type PreparedCapabilityAdd = {
  workflowJson: string;
  message: string;
  result: CommitAgentCapabilityAddResult;
};

async function prepareCapabilityAdd(
  workflowJson: string,
  args: CommitAgentCapabilityAddArgs,
): Promise<PreparedCapabilityAdd> {
  let nextWorkflowJson: string;
  let message: string;
  // Pins read out of the snapshot itself — the asset's stanza is the
  // source of truth, so a concurrent writer's pins survive a retry
  // against the latest snapshot instead of being clobbered by a stale
  // side-table read.
  let skills = readPinnedSkillNames(workflowJson);

  switch (args.body.kind) {
    case "toolPackage": {
      // A package already pinned keeps its stored version: re-adding it
      // (e.g. a person re-clicking "add" on something already listed) is
      // a no-op on the version, never a silent bump to whatever the
      // registry's newest tarball happens to be today. Only a name with
      // no existing pin resolves fresh against the registry. An explicit
      // bump is a distinct, explicit input this does not add (CL-7389).
      const packageName = args.body.name;
      const existingPin = readAgentCapabilities(
        workflowJson,
      ).toolPackagePins.find((pin) => pin.name === packageName);
      const pin =
        existingPin ??
        (await resolvePinnedVersion(
          { db: args.db, assetService: args.assetService },
          args.tenantId,
          packageName,
        ));
      nextWorkflowJson = withAgentToolPackagePin(workflowJson, pin);
      message =
        existingPin !== undefined
          ? `${args.handle} already pins ${packageName} at ${existingPin.version}`
          : `Add ${args.body.name} to ${args.handle}`;
      break;
    }
    case "skill": {
      const nextSkills = skills.includes(args.body.name)
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
    result: {
      toolPackagePins: capabilities.toolPackagePins,
      skills,
      ...(capabilities.model !== undefined
        ? { model: capabilities.model }
        : {}),
    },
  };
}
