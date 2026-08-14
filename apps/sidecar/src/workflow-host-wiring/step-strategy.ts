// Per-deploy step address/repo strategy and grants writing: the
// deployment-id derivation, the single-step vs. multi-step choice of
// per-step mail address and agent-state repo id, and the pre-spawn
// write of every step's grants into its agent-state repo.

import {
  parseAgentId,
  type Principal,
  type RepoStore,
} from "@intx/hub-sessions";
import {
  STEP_GRANTS_PATH,
  STEP_GRANTS_REF,
  type DeriveStepAddress,
  type DeriveStepRepoId,
} from "@intx/workflow-host";
import { deriveWorkflowRunRepoId } from "@intx/workflow-deploy";

import { runGrantsPath } from "../run-grants";

/**
 * Project an agent address into the substrate-safe id of its
 * workflow-run repo. Both deploy branches key `{ kind: "workflow-run",
 * id }` by this slug, and the supervisor principal's `deploymentId`
 * must equal that id for the workflow-run kind handler's authz check to
 * pass. The derivation is owned by `@intx/workflow-deploy` so the hub's
 * read routes reconstruct the identical id; this thin delegator keeps
 * the sidecar's call sites readable while the rationale and the
 * substrate `SAFE_REPO_ID` contract live with the shared function.
 */
export function deriveDeploymentId(agentAddress: string): string {
  return deriveWorkflowRunRepoId(agentAddress);
}

/**
 * Hub principal the deploy router presents when it writes a step's
 * grants into the agent-state repo on the sidecar's substrate. The
 * agent-state kind handler gates `writeTree` as hub-only; the deploy
 * router is the local stand-in for the hub on the sidecar's disk, so it
 * claims the hub principal for this single bookkeeping write. The child
 * reads the same repo via the working-tree path (`getRepoDir`), which is
 * not authorize-gated.
 */
const GRANTS_WRITE_PRINCIPAL: Principal = { kind: "hub" };

/**
 * Per-deploy address/repo strategy. The single-step launched-agent
 * deploy and the derived multi-step deploy disagree on how the per-step
 * mail address and agent-state repo id are computed; both
 * `deriveStepAddress` (consumed by the supervisor's credentialsSnapshot
 * assembly for the step's mail address) and `deriveStepRepoId` (consumed
 * by the same assembly to locate each step's grants) must agree on the
 * choice, so they are minted together.
 */
export type StepStrategy = {
  deriveStepAddress: DeriveStepAddress;
  deriveStepRepoId: DeriveStepRepoId;
};

/**
 * Decide the per-step address/repo strategy from the projection's step
 * count.
 *
 * `stepOrder.length === 1` is the agent-launch identity deploy: the sole
 * step IS the legacy launched agent, so its grants live in the legacy
 * agent-state repo keyed by `parseAgentId(legacyAddress)`. This is
 * exactly the repo the legacy agent identity keys, so the spawned child
 * reads the agent's grants from where the agent's identity already
 * lives, and the deployment frame's `ins_<hex>` address is preserved
 * (the deploy-ack listener finds the `agent_instance` row, the
 * workflow-run repo stays keyed by `deriveWorkflowRunRepoId(legacy)`).
 *
 * Any other step count is a derived multi-step deploy: each step gets a
 * derived `<deploymentId>-<stepId>` mail address (via the router's
 * `multistepDeriveStepAddress`) and a derived agent-state repo under the
 * default `<deploymentId>-<stepId>` convention.
 *
 * NOTE: the supervisor's `deriveStepAddress` feeds the credentials
 * snapshot's per-step mail `address` and the grants-repo derivation. It
 * does NOT feed the child's on-disk tool read (`stepDeployTreeDir` in
 * `step-agent-tools.ts`), which re-derives the step address from the
 * deployment mailbox address independently. The deploy tree must
 * therefore be staged at the address `stepDeployTreeDir` computes,
 * regardless of this strategy's address choice.
 */
export function createStepStrategy(args: {
  legacyAddress: string;
  stepOrder: readonly string[];
  multistepDeriveStepAddress: DeriveStepAddress;
}): StepStrategy {
  if (args.stepOrder.length === 1) {
    return {
      deriveStepAddress: () => args.legacyAddress,
      // `parseAgentId` is deferred into the closure rather than computed
      // eagerly: the supervisor only invokes `deriveStepRepoId` while
      // assembling the credentialsSnapshot inside `spawn()`, so a
      // malformed address surfaces at the same point the rest of the
      // spawn path would fault rather than ahead of the deploy router's
      // other boundary checks.
      deriveStepRepoId: () => ({
        kind: "agent-state",
        id: parseAgentId(args.legacyAddress),
      }),
    };
  }
  return {
    deriveStepAddress: args.multistepDeriveStepAddress,
    deriveStepRepoId: ({ runId, stepId }) => ({
      kind: "agent-state",
      id: `${runId}-${stepId}`,
    }),
  };
}

/**
 * Write every step's grants into its agent-state repo so the
 * supervisor's `assembleCredentialsSnapshot` (invoked inside `spawn()`)
 * reads them off the working tree at `STEP_GRANTS_PATH`. The on-disk
 * shape is `{ grants: WireGrantRule[] }` -- the envelope
 * `assembleCredentialsSnapshot` validates (`{ grants: unknown[] }`) and
 * the child's `evaluateGrants` adapter narrows to `GrantRule[]`.
 *
 * The same `deriveStepRepoId` the supervisor reads with keys the write,
 * so read and write address the same repo. The write is on the spawn
 * critical path: a failure rejects the deploy (the caller's `finally`
 * unwinds the partial state) rather than spawning a child that would
 * fail every authorize closed against an empty grant set.
 */
export async function writeStepGrants(args: {
  repoStore: RepoStore;
  deploymentId: string;
  stepOrder: readonly string[];
  deriveStepRepoId: DeriveStepRepoId;
  grants: readonly unknown[] | undefined;
  /**
   * When present, selects the per-run mode: one write of
   * `runs/<runId>/grants.json` into the deployment's `workflow-run` repo
   * (the destination the hub's `run.grants` frame targets) instead of the
   * per-step agent-state fan-out. The step fan-out fields are inert in
   * that mode but the shared write machinery still takes them.
   */
  runId?: string;
}): Promise<void> {
  // The deploy frame's validated HarnessConfig always carries a `grants`
  // array (possibly empty); an absent array means "no grants", which
  // serializes to the same fail-closed empty file the snapshot expects.
  // Coerce here so the on-disk envelope is always a valid `{ grants: [] }`
  // rather than `{}` (which the snapshot's validator rejects).
  const grants = args.grants ?? [];
  const serialized = JSON.stringify({ grants }, null, 2);
  if (args.runId !== undefined) {
    await args.repoStore.writeTree(
      GRANTS_WRITE_PRINCIPAL,
      { kind: "workflow-run", id: args.deploymentId },
      STEP_GRANTS_REF,
      {
        files: { [runGrantsPath(args.runId)]: serialized },
        message: `Write run grants for ${args.runId}`,
      },
    );
    return;
  }
  for (const stepId of args.stepOrder) {
    const repoId = args.deriveStepRepoId({
      runId: args.deploymentId,
      stepId,
    });
    await args.repoStore.writeTree(
      GRANTS_WRITE_PRINCIPAL,
      repoId,
      STEP_GRANTS_REF,
      {
        files: { [STEP_GRANTS_PATH]: serialized },
        message: `Write step grants for ${stepId}`,
      },
    );
  }
}
