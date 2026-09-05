// Launches a workflow run from a verified webhook delivery through
// Interchange's `prepareProvisionedDeployment` — the same provisioned
// front chat's in-progress `provisionOnAsset` already drives. This
// package renders agent-runtime source onto the definition asset, then
// asks Interchange to provision; it does not mint the run row itself.
//
// Opening mail is one `sessionService.sendUserMessage`. Launch is
// async: mail sent before ready is queued. A delivery already accepted
// (202) has already committed a real run by the time this send runs, so
// a failed mail must not throw past `createWebhookIngressRoutes` — that
// would both hide the run (no `store.recordFired` call) and, if the
// sender's webhook client retries the same delivery on a 5xx, mint a
// second, duplicate run for one event. On send failure this only
// reports through `@corbits/error-sink`, naming the run.
import {
  AGENT_RUNTIME_ENTRY_PATH,
  renderAgentRuntimeSourceTree,
  type AgentRuntimeConfig,
} from "@corbits/agent-runtime";
import { reportError } from "@corbits/error-sink";
import { readDefinitionProjection, readFoldedBody } from "@corbits/folded-runs";
import { listVisibleOfferings, type DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import {
  DEFAULT_ASSET_REF,
  type AssetService,
  type SessionService,
  type WorkflowAllocationService,
} from "@intx/hub-sessions";
import { formatRunAddress, type CredentialCipher } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import { and, eq } from "drizzle-orm";

import { renderInputTemplate } from "./mapping";
import type { WebhookTriggerRow } from "./schema";

export type CryptoProviderCache = {
  get(key: string): Promise<CryptoProvider>;
};

export type LaunchWebhookTriggerDeps = {
  db: DB["db"];
  assetService: Pick<AssetService, "populateAsset">;
  workflowAllocationService: Pick<
    WorkflowAllocationService,
    "prepareProvisionedDeployment"
  >;
  sessionService: Pick<SessionService, "sendUserMessage">;
  cryptoProviderCache: CryptoProviderCache;
  /**
   * Host-supplied cipher. Interchange decrypts bindings inside
   * `prepareProvisionedDeployment`; this port still owns the field so
   * the composition root can keep passing the cipher it tagged at boot.
   */
  credentialCipher: CredentialCipher;
  /**
   * The shape the launched run deploys as — the host wires this to
   * `@corbits/chat`'s `AGENT_SECTION_MODE`, the same `onTrigger`
   * section every room-invited agent deploys as (CL-6329). Injected
   * rather than imported because this package never depends on chat.
   */
  launchMode: AgentRuntimeConfig["mode"];
  /**
   * Records the relaunch mapping after Interchange has prepared the
   * run. Invoked with Interchange's returned `anchorRunId`, not a
   * pre-minted id used as the run. No nested transaction: the host
   * writes after prepare has already committed the run rows.
   */
  persistLaunch: (input: {
    readonly tenantId: string;
    readonly instanceId: string;
    readonly foldedBody: ReturnType<typeof readFoldedBody>;
  }) => void | Promise<void>;
  /**
   * Records the inference chain the launch just deployed with.
   * Digest is the joined catalog offering ids, same as chat's
   * `offeringDigest`.
   */
  recordLaunchSources: (input: {
    readonly instanceId: string;
    readonly sourcesDigest: string;
  }) => Promise<void>;
};

export type LaunchedWebhookTrigger = {
  readonly instanceId: string;
  readonly triggerAddress: string;
};

function offeringDigest(sourceOfferingIds: readonly string[]): string {
  return sourceOfferingIds.join("\0");
}

/**
 * Resolves the trigger's referenced workflow definition (must be
 * deployed and materialized), renders agent-runtime source onto its
 * asset, provisions through Interchange, then delivers the rendered
 * input mapping as the run's first inbound message. The webhook sender
 * itself is never a principal on the platform, so the mail's `from`
 * names the trigger, not a person.
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

  const projection = await readDefinitionProjection(deps.db, definitionRow);
  const foldedBody = readFoldedBody(
    projection,
    definitionRow.grantRequirements,
  );
  if (foldedBody.systemPrompt === "") {
    throw new Error(
      `workflow definition "${trigger.workflowDefinitionId}" cannot be ` +
        "launched without a system prompt configured",
    );
  }

  const offerings = [...(await listVisibleOfferings(deps.db, trigger.tenantId))].sort(
    (a, b) => a.offering.priority - b.offering.priority,
  );
  const sourceOfferingIds = offerings.map((o) => o.offering.id);
  const defaultSourceOfferingId = sourceOfferingIds[0];
  if (defaultSourceOfferingId === undefined) {
    throw new Error(
      `no catalog offerings visible to tenant "${trigger.tenantId}"`,
    );
  }

  const assetId = definitionRow.assetId;
  const anchorRunId = generateId("workflowRun");
  const sessionId = generateId("session");
  const triggerAddress = formatRunAddress(anchorRunId, tenantRow.domain);

  const { commitSha } = await deps.assetService.populateAsset({
    assetId,
    ref: DEFAULT_ASSET_REF,
    principal: { kind: "hub" },
    tree: {
      files: renderAgentRuntimeSourceTree({
        packageName: `agent-${anchorRunId}`,
        config: {
          workflowId: `wf_${anchorRunId}`,
          agentId: anchorRunId,
          triggerAddress,
          systemPrompt: foldedBody.systemPrompt,
          inferencePreferences: offerings.map((o) => ({
            provider: o.provider.name,
            model: o.model.canonicalName,
          })),
          toolPackagePins: [...foldedBody.toolPackagePins],
          credentialBindings: [...foldedBody.credentialBindings],
          mode: deps.launchMode,
        },
      }),
      message: `Provision agent ${anchorRunId}`,
    },
  });

  const prepared =
    await deps.workflowAllocationService.prepareProvisionedDeployment({
      tenantId: trigger.tenantId,
      anchorRunId,
      sessionId,
      deploymentDomain: tenantRow.domain,
      source: {
        kind: "asset",
        assetId,
        package: { format: "source", commitSha },
      },
      entry: AGENT_RUNTIME_ENTRY_PATH,
      definitionAssetId: assetId,
      sourceAuthorityPrincipalId: trigger.createdBy,
      sourceOfferingIds,
      defaultSourceOfferingId,
      deployContent: { systemPrompt: "" },
      ...(foldedBody.toolPackagePins.length > 0
        ? { toolPackagePins: foldedBody.toolPackagePins }
        : {}),
    });

  await deps.persistLaunch({
    tenantId: trigger.tenantId,
    instanceId: prepared.anchorRunId,
    foldedBody,
  });
  await deps.recordLaunchSources({
    instanceId: prepared.anchorRunId,
    sourcesDigest: offeringDigest(sourceOfferingIds),
  });

  const content = renderInputTemplate(trigger.inputTemplate, payload);
  const cryptoProvider = await deps.cryptoProviderCache.get(
    prepared.anchorRunId,
  );
  try {
    await deps.sessionService.sendUserMessage({
      agentAddress: prepared.deploymentAddress,
      from: `webhook-trigger:${trigger.id}`,
      messageId: `<${crypto.randomUUID()}@${tenantRow.domain}>`,
      date: new Date(),
      content,
      sessionId,
      tenantId: trigger.tenantId,
      cryptoProvider,
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
