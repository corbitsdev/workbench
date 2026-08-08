// Re-deploys a folded run's instance when the sidecar no longer has it
// resident — either it slept (an idle-sleep sweep) or the stack
// restarted and never relaunched it. The caller reads its own
// launch-body persistence (e.g. `@corbits/chat`'s `channel_launch`
// row) and passes the resulting `foldedBody` in — a channel host's
// asset never materializes a workflow.json, so the definition's asset
// cannot be the wake source, and `folded-runs` has no launch-body
// table of its own to read.
import { deployAtHead } from "./launch";
import { resolveFoldedRunSessionId } from "./runs";
import type { FoldedRunsDeps } from "./types";
import type { FoldedBody } from "@intx/workflow-deploy";

export type WakeFoldedRunParams = {
  tenantId: string;
  instanceId: string;
  triggerAddress: string;
  principalId: string | null;
  foldedBody: FoldedBody;
};

export async function wakeFoldedRun(
  deps: FoldedRunsDeps,
  params: WakeFoldedRunParams,
): Promise<void> {
  if (params.principalId === null) {
    throw new Error(`Run "${params.instanceId}" has no principal`);
  }
  const sessionId = await resolveFoldedRunSessionId(deps.db, {
    principalId: params.principalId,
  });

  await deployAtHead(deps, {
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    triggerAddress: params.triggerAddress,
    principalId: params.principalId,
    sessionId,
    foldedBody: params.foldedBody,
    launchLabel: "the woken instance",
  });
}
