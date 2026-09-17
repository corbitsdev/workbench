// Launches a workflow run from a verified webhook delivery through
// Interchange's `prepareProvisionedDeployment` — the same provisioned
// front chat's `provisionOnAsset` already drives. This package resolves
// the definition asset HEAD and asks Interchange to provision that
// existing source; it does not mint the run row itself.
//
// Opening mail is one signed `SidecarRouter.routeMail` delivery. Launch is
// async: mail sent before ready is queued. A delivery already accepted
// (202) has already committed a real run by the time this send runs, so
// a failed mail must not throw past `createWebhookIngressRoutes` — that
// would both hide the run (no `store.recordFired` call) and, if the
// sender's webhook client retries the same delivery on a 5xx, mint a
// second, duplicate run for one event. On send failure this only
// reports through `@corbits/error-sink`, naming the run.
import { reportError } from "@corbits/error-sink";
import {
  deliverWhenRoutable,
  recordAgentSessionAtProvision,
  WORKFLOW_SOURCE_ENTRY,
  type EventCollectorPort,
} from "@corbits/workflows";
import { listVisibleOfferings, type DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import {
  assembleMessage,
  assembleSignedContent,
  createDetachedSignatureFromProvider,
  type MessageHeaders,
} from "@intx/mime";
import { base64Encode, type CredentialCipher } from "@intx/types";
import {
  DEFAULT_ASSET_REF,
  type RepoStore,
  type SidecarRouter,
  type WorkflowAllocationService,
} from "@intx/hub-sessions";
import { and, eq } from "drizzle-orm";

import { renderInputTemplate } from "./mapping";
import type { WebhookTriggerRow } from "./schema";

import type { CryptoProviderCache } from "./crypto-cache";

export type LaunchWebhookTriggerDeps = {
  db: DB["db"];
  repoStore: Pick<RepoStore, "resolveRef">;
  workflowAllocationService: Pick<WorkflowAllocationService, "prepareProvisionedDeployment">;
  sidecarRouter: Pick<SidecarRouter, "routeMail">;
  /**
   * The same wrapped `EventCollectorRegistry` every native launcher
   * threads through (`apps/hub/src/index.ts`'s `eventCollectors`) — this
   * launcher records the run's `agent_session` and event collector the
   * instant `prepareProvisionedDeployment` returns (CL-7481).
   */
  eventCollectors: Pick<EventCollectorPort, "create" | "has">;
  /**
   * Reads the hub's live sidecar routing table. A freshly provisioned
   * run's sidecar takes several seconds to boot and register (CL-7476)
   * — a webhook's opening mail can land in that gap and fail with
   * "agent is unreachable" even though the run itself deployed fine.
   * `deliverWhenRoutable` polls this until the address is routable
   * before its one retry.
   */
  isRoutable: (address: string) => boolean;
  cryptoProviderCache: CryptoProviderCache;
  /**
   * Host-supplied cipher. Interchange decrypts bindings inside
   * `prepareProvisionedDeployment`; this port still owns the field so
   * the composition root can keep passing the cipher it tagged at boot.
   */
  credentialCipher: CredentialCipher;
};

export type LaunchedWebhookTrigger = {
  readonly instanceId: string;
  readonly triggerAddress: string;
};

/**
 * Resolves the trigger's referenced workflow definition (must be
 * deployed and materialized), provisions its existing asset HEAD
 * through Interchange, then delivers the rendered input mapping as
 * the run's first inbound message. The webhook sender itself is never
 * a principal on the platform, so the mail's `from` names the trigger,
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
      `workflow definition "${trigger.workflowDefinitionId}" has not been ` + "materialized",
    );
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenantTable.id, trigger.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`no tenant "${trigger.tenantId}"`);
  }

  const offerings = [...(await listVisibleOfferings(deps.db, trigger.tenantId))].sort(
    (a, b) => a.offering.priority - b.offering.priority,
  );
  const sourceOfferingIds = offerings.map((o) => o.offering.id);
  const defaultSourceOfferingId = sourceOfferingIds[0];
  if (defaultSourceOfferingId === undefined) {
    throw new Error(`no catalog offerings visible to tenant "${trigger.tenantId}"`);
  }

  const assetId = definitionRow.assetId;
  const commitSha = await deps.repoStore.resolveRef(
    { kind: "hub" },
    { kind: "workflow", id: assetId },
    DEFAULT_ASSET_REF,
  );
  if (commitSha === null) {
    throw new Error(`definition asset "${assetId}" has no HEAD`);
  }
  const anchorRunId = generateId("workflowRun");
  const sessionId = generateId("session");

  const prepared = await deps.workflowAllocationService.prepareProvisionedDeployment({
    tenantId: trigger.tenantId,
    anchorRunId,
    sessionId,
    deploymentDomain: tenantRow.domain,
    source: {
      kind: "asset",
      assetId,
      package: { format: "source", commitSha },
    },
    entry: WORKFLOW_SOURCE_ENTRY,
    definitionAssetId: assetId,
    sourceAuthorityPrincipalId: trigger.createdBy,
    sourceOfferingIds,
    defaultSourceOfferingId,
    deployContent: { systemPrompt: "" },
  });

  await recordAgentSessionAtProvision({
    db: deps.db,
    eventCollectors: deps.eventCollectors,
    runId: prepared.anchorRunId,
    sessionId,
    sourceAuthorityPrincipalId: trigger.createdBy,
  });

  const content = renderInputTemplate(trigger.inputTemplate, payload);
  const cryptoProvider = await deps.cryptoProviderCache.get(prepared.anchorRunId);
  try {
    await deliverWhenRoutable({
      send: async () => {
        const from = `webhook-trigger:${trigger.id}`;
        const messageId = `<${crypto.randomUUID()}@${tenantRow.domain}>`;
        const headers: MessageHeaders = {
          from,
          to: [prepared.deploymentAddress],
          cc: undefined,
          date: new Date(),
          messageId,
          subject: undefined,
          inReplyTo: undefined,
          references: undefined,
          mimeVersion: "1.0",
          interchangeType: "conversation.message",
          interchangeCorrelationId: undefined,
          interchangeTenantId: trigger.tenantId,
          interchangeAgentId: undefined,
          interchangeSessionId: sessionId,
          interchangeOfferingId: undefined,
          interchangeSchemaVersion: undefined,
          traceparent: undefined,
          tracestate: undefined,
        };
        const signedContent = assembleSignedContent({ kind: "conversation", text: content });
        const signature = await createDetachedSignatureFromProvider(signedContent, cryptoProvider);
        const rawMessage = assembleMessage(headers, signedContent, signature);
        const delivered = deps.sidecarRouter.routeMail(
          prepared.deploymentAddress,
          base64Encode(rawMessage),
          from,
          messageId,
        );
        if (!delivered) {
          throw new Error(`agent is unreachable: ${prepared.deploymentAddress} is not routable`);
        }
      },
      isRoutable: () => deps.isRoutable(prepared.deploymentAddress),
    });
  } catch (error) {
    reportError(error, {
      operation: "webhookTriggers.launch.deliverInput",
      tenantId: trigger.tenantId,
      agentId: prepared.deploymentAddress,
      extra: {
        instanceId: prepared.anchorRunId,
        triggerId: trigger.id,
      },
    });
  }

  return {
    instanceId: prepared.anchorRunId,
    triggerAddress: prepared.deploymentAddress,
  };
}
