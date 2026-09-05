import { describe, expect, test } from "bun:test";
import { DEFAULT_ASSET_REF } from "@intx/hub-sessions";
import type { PrepareProvisionedWorkflowDeploymentArgs } from "@intx/hub-sessions";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import {
  prepareProvisionedLaunch,
  type PrepareProvisionedLaunchDeps,
  type PrepareProvisionedLaunchParams,
} from "./launch";

const FILES = {
  "package.json": '{"name":"wf-agent","interchange":{"workflow":"./workflow.js"}}',
  "workflow.js": "export default { id: 'wf_1' };\n",
};

const PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/interaction-tools", version: "0.0.7" },
];

const BASE_PARAMS: PrepareProvisionedLaunchParams = {
  tenantId: "ten_1",
  deploymentDomain: "ten1.workbench.test",
  sourceAuthorityPrincipalId: "prin_1",
  definitionAssetId: "asset_wf_1",
  files: FILES,
  entry: "./workflow.js",
  sourceOfferingIds: ["off_1", "off_2"],
  defaultSourceOfferingId: "off_1",
  toolPackagePins: PINS,
};

function fakeDeps(overrides?: {
  readonly populateAsset?: PrepareProvisionedLaunchDeps["assetService"]["populateAsset"];
  readonly prepareProvisionedDeployment?: PrepareProvisionedLaunchDeps["workflowAllocationService"]["prepareProvisionedDeployment"];
}): {
  deps: PrepareProvisionedLaunchDeps;
  populateCalls: Parameters<
    PrepareProvisionedLaunchDeps["assetService"]["populateAsset"]
  >[];
  prepareCalls: PrepareProvisionedWorkflowDeploymentArgs[];
} {
  const populateCalls: Parameters<
    PrepareProvisionedLaunchDeps["assetService"]["populateAsset"]
  >[] = [];
  const prepareCalls: PrepareProvisionedWorkflowDeploymentArgs[] = [];
  const deps: PrepareProvisionedLaunchDeps = {
    assetService: {
      populateAsset: async (params) => {
        populateCalls.push(params);
        if (overrides?.populateAsset !== undefined) {
          return overrides.populateAsset(params);
        }
        return { commitSha: "abc123def" };
      },
    },
    workflowAllocationService: {
      prepareProvisionedDeployment: async (args) => {
        prepareCalls.push(args);
        if (overrides?.prepareProvisionedDeployment !== undefined) {
          return overrides.prepareProvisionedDeployment(args);
        }
        return {
          anchorRunId: args.anchorRunId,
          deploymentAddress: `${args.anchorRunId}@${args.deploymentDomain}`,
          allocationId: "sal_1",
          status: "pending",
        };
      },
    },
    generateIds: () => ({
      anchorRunId: "run_fixed",
      sessionId: "ses_fixed",
    }),
  };
  return { deps, populateCalls, prepareCalls };
}

describe("prepareProvisionedLaunch", () => {
  test("writes the rendered tree onto the instance asset at the default ref", async () => {
    const { deps, populateCalls } = fakeDeps();

    await prepareProvisionedLaunch(deps, BASE_PARAMS);

    expect(populateCalls).toHaveLength(1);
    const call = populateCalls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    expect(call.assetId).toBe("asset_wf_1");
    expect(call.ref).toBe(DEFAULT_ASSET_REF);
    expect(call.principal).toEqual({ kind: "hub" });
    expect(call.tree.files).toEqual(FILES);
    expect(call.ref).not.toMatch(/run_|src_/);
  });

  test("prepares a native provisioned deployment from the written commit", async () => {
    const { deps, prepareCalls } = fakeDeps();

    const result = await prepareProvisionedLaunch(deps, BASE_PARAMS);

    expect(prepareCalls).toHaveLength(1);
    const args = prepareCalls[0];
    expect(args).toBeDefined();
    if (args === undefined) return;
    expect(args.tenantId).toBe("ten_1");
    expect(args.anchorRunId).toBe("run_fixed");
    expect(args.sessionId).toBe("ses_fixed");
    expect(args.deploymentDomain).toBe("ten1.workbench.test");
    expect(args.sourceAuthorityPrincipalId).toBe("prin_1");
    expect(args.definitionAssetId).toBe("asset_wf_1");
    expect(args.entry).toBe("./workflow.js");
    expect(args.source).toEqual({
      kind: "asset",
      assetId: "asset_wf_1",
      package: { format: "source", commitSha: "abc123def" },
    });
    expect(args.sourceOfferingIds).toEqual(["off_1", "off_2"]);
    expect(args.defaultSourceOfferingId).toBe("off_1");
    expect(args.toolPackagePins).toEqual(PINS);
    expect(args.deployContent).toEqual({ systemPrompt: "" });
    expect("pin" in args).toBe(false);

    expect(result).toEqual({
      runId: "run_fixed",
      deploymentId: "run_fixed",
      mailAddress: "run_fixed@ten1.workbench.test",
      allocationId: "sal_1",
      status: "pending",
    });
  });

  test("omits toolPackagePins when the caller supplies none", async () => {
    const { deps, prepareCalls } = fakeDeps();

    await prepareProvisionedLaunch(deps, {
      tenantId: BASE_PARAMS.tenantId,
      deploymentDomain: BASE_PARAMS.deploymentDomain,
      sourceAuthorityPrincipalId: BASE_PARAMS.sourceAuthorityPrincipalId,
      definitionAssetId: BASE_PARAMS.definitionAssetId,
      files: BASE_PARAMS.files,
      entry: BASE_PARAMS.entry,
      sourceOfferingIds: BASE_PARAMS.sourceOfferingIds,
      defaultSourceOfferingId: BASE_PARAMS.defaultSourceOfferingId,
    });

    expect(prepareCalls[0]).toBeDefined();
    expect(prepareCalls[0] !== undefined && "toolPackagePins" in prepareCalls[0]).toBe(
      false,
    );
  });

  test("does not insert agent_session or folded_run rows — only populate + prepare", async () => {
    const inserts: string[] = [];
    const { deps } = fakeDeps({
      populateAsset: async () => {
        inserts.push("populateAsset");
        return { commitSha: "abc123def" };
      },
      prepareProvisionedDeployment: async (args) => {
        inserts.push("prepareProvisionedDeployment");
        return {
          anchorRunId: args.anchorRunId,
          deploymentAddress: `run_fixed@${args.deploymentDomain}`,
          allocationId: "sal_1",
          status: "pending",
        };
      },
    });

    await prepareProvisionedLaunch(deps, BASE_PARAMS);

    expect(inserts).toEqual(["populateAsset", "prepareProvisionedDeployment"]);
  });
});
