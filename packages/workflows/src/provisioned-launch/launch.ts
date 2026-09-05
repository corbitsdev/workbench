// Shared native launcher for a workbench agent: write the already-rendered
// workflow source tree onto the instance's own `kind:workflow` asset at the
// default ref, then call Interchange's `prepareProvisionedDeployment`.
// Callers that need an agent-runtime definition render it first via
// `renderAgentRuntimeSourceTree`; this module never imports that package
// (it already depends on `@corbits/workflows`).
import { generateId } from "@intx/hub-common";
import {
  DEFAULT_ASSET_REF,
  type AssetService,
  type WorkflowAllocationService,
} from "@intx/hub-sessions";
import type { ToolPackagePin } from "@intx/types/tool-packages";

export type PrepareProvisionedLaunchDeps = {
  readonly assetService: Pick<AssetService, "populateAsset">;
  readonly workflowAllocationService: Pick<
    WorkflowAllocationService,
    "prepareProvisionedDeployment"
  >;
  /** Test seam. Production uses `generateId("workflowRun" | "session")`. */
  readonly generateIds?: () => {
    readonly anchorRunId: string;
    readonly sessionId: string;
  };
};

export type PrepareProvisionedLaunchParams = {
  readonly tenantId: string;
  readonly deploymentDomain: string;
  readonly sourceAuthorityPrincipalId: string;
  /** The instance's own `kind:workflow` asset. */
  readonly definitionAssetId: string;
  readonly files: Readonly<Record<string, string>>;
  readonly entry: string;
  readonly sourceOfferingIds: readonly string[];
  readonly defaultSourceOfferingId: string;
  readonly toolPackagePins?: readonly ToolPackagePin[];
  readonly commitMessage?: string;
};

export type PreparedProvisionedLaunch = {
  readonly runId: string;
  readonly deploymentId: string;
  readonly mailAddress: string;
  readonly allocationId: string;
  readonly status: "pending";
};

function defaultGenerateIds(): {
  readonly anchorRunId: string;
  readonly sessionId: string;
} {
  return {
    anchorRunId: generateId("workflowRun"),
    sessionId: generateId("session"),
  };
}

/**
 * Rendered source → native provisioned deployment. Returns the ids
 * Interchange minted; the caller records those and nothing else.
 * Wake is the same call onto the same asset.
 */
export async function prepareProvisionedLaunch(
  deps: PrepareProvisionedLaunchDeps,
  params: PrepareProvisionedLaunchParams,
): Promise<PreparedProvisionedLaunch> {
  const { commitSha } = await deps.assetService.populateAsset({
    assetId: params.definitionAssetId,
    ref: DEFAULT_ASSET_REF,
    principal: { kind: "hub" },
    tree: {
      files: { ...params.files },
      message:
        params.commitMessage ??
        `Deploy provisioned workflow ${params.definitionAssetId}`,
    },
  });
  const ids = (deps.generateIds ?? defaultGenerateIds)();
  const prepared =
    await deps.workflowAllocationService.prepareProvisionedDeployment({
      tenantId: params.tenantId,
      anchorRunId: ids.anchorRunId,
      deploymentDomain: params.deploymentDomain,
      source: {
        kind: "asset",
        assetId: params.definitionAssetId,
        package: { format: "source", commitSha },
      },
      entry: params.entry,
      definitionAssetId: params.definitionAssetId,
      sessionId: ids.sessionId,
      sourceAuthorityPrincipalId: params.sourceAuthorityPrincipalId,
      sourceOfferingIds: params.sourceOfferingIds,
      defaultSourceOfferingId: params.defaultSourceOfferingId,
      deployContent: { systemPrompt: "" },
      ...(params.toolPackagePins !== undefined &&
      params.toolPackagePins.length > 0
        ? { toolPackagePins: params.toolPackagePins }
        : {}),
    });
  return {
    runId: prepared.anchorRunId,
    deploymentId: prepared.anchorRunId,
    mailAddress: prepared.deploymentAddress,
    allocationId: prepared.allocationId,
    status: prepared.status,
  };
}
