// Launches a workflow run from a verified webhook delivery, through
// the exact same primitive `@corbits/chat`'s invite flow uses
// (`launchFoldedRun` from `@corbits/folded-runs`) rather than any
// route-internal reimplementation of session orchestration. This
// package never talks to `sessionService`/`sidecarRouter` directly —
// only through `folded-runs`, the shared launch core the platform's
// own `POST /workflows/runs` route is mirrored from.
//
// The post-launch mail send is hardened the same way
// `apps/hub/src/routine-launcher.ts` hardens its own identical shape
// (both call the one shared `sendFoldedMailWithRetry` seam in
// `@corbits/folded-runs`, so this is one behavior, not two copies of
// it): a delivery already accepted (202) has already committed a real
// run by the time this function's own `sendFoldedMailWithRetry` call
// runs, so a delivery-failed mail must not throw past
// `createWebhookIngressRoutes` — that would both hide the run (no
// `store.recordFired` call) and, if the sender's webhook client retries
// the same delivery on a 5xx, mint a second, duplicate run for one
// event. On exhausted retries this only logs, naming the run.
import { and, eq } from "drizzle-orm";
import {
  domainOf,
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMailWithRetry,
  type FoldedRunsDeps,
  type CryptoProviderCache,
} from "@corbits/folded-runs";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { formatRunAddress } from "@intx/types";

import { renderInputTemplate } from "./mapping";
import type { WebhookTriggerRow } from "./schema";

const log = getLogger(["webhook-triggers", "launch"]);

export type LaunchWebhookTriggerDeps = FoldedRunsDeps & {
  db: DB["db"];
  cryptoProviderCache: CryptoProviderCache;
};

export type LaunchedWebhookTrigger = {
  readonly instanceId: string;
  readonly triggerAddress: string;
};

/**
 * Resolves the trigger's referenced workflow definition (must be
 * deployed and materialized, same precondition `@corbits/chat`'s
 * `launchInvite` enforces), launches it via `launchFoldedRun`, then
 * delivers the rendered input mapping as the run's first inbound
 * message via `sendFoldedMailWithRetry` — the same mail primitive a
 * chat message send uses, bounded-retried rather than a bare send (see
 * the module doc comment). The webhook sender itself is never a
 * principal on the platform, so the mail's `from` names the trigger,
 * not a person.
 */
export async function launchWebhookTrigger(
  deps: LaunchWebhookTriggerDeps,
  trigger: WebhookTriggerRow,
  payload: unknown,
): Promise<LaunchedWebhookTrigger> {
  const definitionRow = await deps.db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.id, trigger.workflowDefinitionId),
      eq(workflowDefinition.tenantId, trigger.tenantId),
    ),
  });
  if (definitionRow === undefined) {
    throw new Error(
      `webhook trigger "${trigger.id}" names no workflow definition ` +
        `"${trigger.workflowDefinitionId}" for its tenant`,
    );
  }
  if (definitionRow.status !== "deployed") {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" is not in a ` +
        `launchable state (status: ${definitionRow.status})`,
    );
  }
  if (definitionRow.assetId === null) {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" has not been ` +
        "materialized",
    );
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenantTable.id, trigger.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`no tenant "${trigger.tenantId}"`);
  }

  const definitionJSON = await readDefinitionJSON(
    deps.assetService,
    definitionRow.assetId,
  );
  const foldedBody = readFoldedBody(definitionJSON);
  if (foldedBody.systemPrompt === "") {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" cannot be ` +
        "launched without a system prompt configured",
    );
  }

  const instanceId = generateId("workflowRun");
  const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

  const launched = await launchFoldedRun(deps, {
    tenantId: trigger.tenantId,
    instanceId,
    triggerAddress,
    definitionId: trigger.workflowDefinitionId,
    foldedBody,
    launchLabel: `webhook trigger "${trigger.name}"`,
  });

  const content = renderInputTemplate(trigger.inputTemplate, payload);
  const cryptoProvider = await deps.cryptoProviderCache.get(instanceId);
  const result = await sendFoldedMailWithRetry(deps, {
    tenantId: trigger.tenantId,
    sessionId: launched.sessionId,
    agentAddress: triggerAddress,
    from: `webhook-trigger:${trigger.id}`,
    domain: domainOf(triggerAddress),
    content,
    cryptoProvider,
  });
  if (!result.ok) {
    const reason =
      result.error instanceof Error
        ? result.error.message
        : String(result.error);
    log.error`run ${instanceId} launched from webhook trigger "${trigger.id}" but its input failed to deliver after ${result.attempts} attempts: ${reason}`;
  }

  return { instanceId, triggerAddress };
}
