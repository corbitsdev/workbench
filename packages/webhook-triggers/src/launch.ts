// Launches a workflow run from a verified webhook delivery, through
// the exact same primitive `@corbits/chat`'s invite flow uses
// (`launchFoldedRun` from `@corbits/folded-runs`) rather than any
// route-internal reimplementation of session orchestration. This
// package never talks to `sessionService`/`sidecarRouter` directly —
// only through `folded-runs`, the shared launch core the platform's
// own `POST /workflows/runs` route is mirrored from.
import { and, eq } from "drizzle-orm";
import {
  domainOf,
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMail,
  type FoldedRunsDeps,
  type CryptoProviderCache,
} from "@corbits/folded-runs";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { formatAgentAddress } from "@intx/types";

import { renderInputTemplate } from "./mapping";
import type { WebhookTriggerRow } from "./schema";

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
 * message via `sendFoldedMail` — the same mail primitive a chat
 * message send uses. The webhook sender itself is never a principal
 * on the platform, so the mail's `from` names the trigger, not a
 * person.
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

  const instanceId = generateId("instance");
  const triggerAddress = formatAgentAddress(instanceId, tenantRow.domain);

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
  await sendFoldedMail(deps, {
    tenantId: trigger.tenantId,
    sessionId: launched.sessionId,
    agentAddress: triggerAddress,
    from: `webhook-trigger:${trigger.id}`,
    domain: domainOf(triggerAddress),
    content,
    cryptoProvider,
  });

  return { instanceId, triggerAddress };
}
