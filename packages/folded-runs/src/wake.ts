// Re-deploys a folded run's instance when the sidecar no longer has it
// resident — either it slept (an idle-sleep sweep) or the stack
// restarted and never relaunched it. The caller reads its own
// launch-body persistence (e.g. `@corbits/chat`'s `channel_launch`
// row) and passes the resulting `foldedBody` in — a channel host's
// asset never materializes a workflow.json, so the definition's asset
// cannot be the wake source, and `folded-runs` has no launch-body
// table of its own to read.
import { eq } from "drizzle-orm";
import { sessionAsset } from "@intx/db/schema";
import { deployAtHead, type SourcesOverride } from "./launch";
import { resolveFoldedRunSessionId } from "./runs";
import type { FoldedRunsDeps } from "./types";
import type { FoldedBody } from "@intx/workflow-deploy";
import type { Selector } from "@intx/workflow";

export type WakeFoldedRunParams = {
  tenantId: string;
  instanceId: string;
  triggerAddress: string;
  principalId: string | null;
  foldedBody: FoldedBody;
  /**
   * When present, used verbatim in place of catalog resolution — see
   * `deployAtHead`'s own doc on the same field. A wake re-deploys with
   * whatever pin the caller decided at launch time (e.g.
   * `@corbits/chat`'s `channel_launch.noopInference` column), never
   * re-derives it.
   */
  sources?: SourcesOverride;
  /**
   * See `deployAtHead`'s own doc on the same field. A wake must repin
   * whatever the original launch pinned — the channel host's literal
   * input is a property of what the run IS, not of how it was deployed
   * this particular time, so re-deploying it on the default
   * `trigger.payload` selector would silently restore the CL-6164 crash
   * on the very next mail this occurrence receives.
   */
  stepInput?: Selector;
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

  // A wake redeploys the same instance id the settled occurrence used.
  // The platform's ordinary launch reserves one `session_asset` manifest
  // row per (instance, mount path) with no conflict handling — a
  // duplicate-launch guard that is right for one-shot deployments and
  // wrong for a folded run, whose whole lifecycle is "settle, then
  // redeploy this very id". The undeploy that precedes every wake tears
  // the sidecar workspace down, so the previous occurrence's manifest
  // rows are stale by construction: clear them here, or the redeploy
  // dies on the primary key and the conversation goes silent.
  await deps.db
    .delete(sessionAsset)
    .where(eq(sessionAsset.runId, params.instanceId));

  const deployAtHeadParams = {
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    triggerAddress: params.triggerAddress,
    principalId: params.principalId,
    sessionId,
    foldedBody: params.foldedBody,
    launchLabel: "the woken instance",
  };
  await deployAtHead(deps, {
    ...deployAtHeadParams,
    ...(params.sources !== undefined ? { sources: params.sources } : {}),
    ...(params.stepInput !== undefined
      ? { stepInput: params.stepInput }
      : {}),
  });
}
