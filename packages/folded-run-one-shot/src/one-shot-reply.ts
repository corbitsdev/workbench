// A synchronous wrapper around one provisioned run's opening turn:
// prepare, send the prompt, wait for exactly one reply, tear down the
// subscription AND the launched run itself. Other launchers return as
// soon as the run starts; this module turns the event stream into an
// awaitable promise for a caller that has no later-delivery surface.
import { and, eq } from "drizzle-orm";
import {
  AGENT_RUNTIME_ENTRY_PATH,
  renderAgentRuntimeSourceTree,
  type AgentRuntimeConfig,
} from "@corbits/agent-runtime";
import type { AgentLifecycle } from "@corbits/agent-lifecycle";
import { connectorReplyContent, messageRunEnded } from "@corbits/agent-events";
import { readDefinitionProjection, readFoldedBody } from "@corbits/workflows";
import { listVisibleOfferings, type DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import {
  DEFAULT_ASSET_REF,
  type AssetService,
  type SessionService,
  type SidecarEventEmitter,
  type WorkflowAllocationService,
} from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import type { FoldedBody } from "@intx/workflow-deploy";

const log = getLogger(["folded-run-one-shot"]);

export type CryptoProviderCache = {
  get(key: string): Promise<CryptoProvider>;
};

export type OneShotReply = {
  readonly content: string;
  readonly runId: string;
};

export type ProvisionedOneShot = {
  readonly runId: string;
  readonly address: string;
  readonly sessionId: string;
};

export type OneShotRunnerDeps = {
  readonly db: DB["db"];
  readonly events: SidecarEventEmitter;
  readonly cryptoProviders: CryptoProviderCache;
  readonly undeploy: (address: string, reason: string) => Promise<void>;
  readonly lifecycle?: Pick<
    AgentLifecycle,
    "track" | "recordActivity" | "untrack"
  >;
  readonly assetService: Pick<AssetService, "populateAsset">;
  readonly workflowAllocationService: Pick<
    WorkflowAllocationService,
    "prepareProvisionedDeployment"
  >;
  readonly sessionService: Pick<SessionService, "sendUserMessage">;
  readonly launchMode: AgentRuntimeConfig["mode"];
  /**
   * Test seam only. Production never sets these; they default to
   * Interchange `prepareProvisionedDeployment` and `sendUserMessage`.
   */
  readonly provision?: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly definitionId: string;
    readonly foldedBody: FoldedBody;
    readonly domain: string;
  }) => Promise<ProvisionedOneShot>;
  readonly sendMail?: (input: {
    readonly tenantId: string;
    readonly sessionId: string;
    readonly agentAddress: string;
    readonly from: string;
    readonly content: string;
    readonly cryptoProvider: CryptoProvider;
  }) => Promise<void>;
};

export type OneShotPromptInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly timeoutMs: number;
};

export class OneShotDefinitionNotFoundError extends Error {
  constructor(definitionId: string) {
    super(`No definition "${definitionId}" for this tenant`);
    this.name = "OneShotDefinitionNotFoundError";
  }
}

export class FoldedRunTimedOutError extends Error {
  constructor(timeoutMs: number) {
    super(`the folded run did not reply within ${String(timeoutMs)}ms`);
    this.name = "FoldedRunTimedOutError";
  }
}

export class FoldedRunFailedError extends Error {
  constructor(errorMessage: string | undefined) {
    super(
      errorMessage !== undefined
        ? `the folded run failed: ${errorMessage}`
        : "the folded run failed",
    );
    this.name = "FoldedRunFailedError";
  }
}

async function provisionOnAsset(
  deps: OneShotRunnerDeps,
  input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly definitionAssetId: string;
    readonly foldedBody: FoldedBody;
    readonly domain: string;
  },
): Promise<ProvisionedOneShot> {
  const offerings = [...(await listVisibleOfferings(deps.db, input.tenantId))].sort(
    (a, b) => a.offering.priority - b.offering.priority,
  );
  const sourceOfferingIds = offerings.map((o) => o.offering.id);
  const defaultSourceOfferingId = sourceOfferingIds[0];
  if (defaultSourceOfferingId === undefined) {
    throw new Error(
      `no catalog offerings visible to tenant "${input.tenantId}"`,
    );
  }
  const anchorRunId = generateId("workflowRun");
  const sessionId = generateId("session");
  const triggerAddress = formatRunAddress(anchorRunId, input.domain);
  const { commitSha } = await deps.assetService.populateAsset({
    assetId: input.definitionAssetId,
    ref: DEFAULT_ASSET_REF,
    principal: { kind: "hub" },
    tree: {
      files: renderAgentRuntimeSourceTree({
        packageName: `agent-${anchorRunId}`,
        config: {
          workflowId: `wf_${anchorRunId}`,
          agentId: anchorRunId,
          triggerAddress,
          systemPrompt: input.foldedBody.systemPrompt,
          inferencePreferences: offerings.map((o) => ({
            provider: o.provider.name,
            model: o.model.canonicalName,
          })),
          toolPackagePins: [...input.foldedBody.toolPackagePins],
          credentialBindings: [...input.foldedBody.credentialBindings],
          mode: deps.launchMode,
        },
      }),
      message: `Provision agent ${anchorRunId}`,
    },
  });
  const prepared =
    await deps.workflowAllocationService.prepareProvisionedDeployment({
      tenantId: input.tenantId,
      anchorRunId,
      sessionId,
      deploymentDomain: input.domain,
      source: {
        kind: "asset",
        assetId: input.definitionAssetId,
        package: { format: "source", commitSha },
      },
      entry: AGENT_RUNTIME_ENTRY_PATH,
      definitionAssetId: input.definitionAssetId,
      sourceAuthorityPrincipalId: input.principalId,
      sourceOfferingIds,
      defaultSourceOfferingId,
      deployContent: { systemPrompt: "" },
      ...(input.foldedBody.toolPackagePins.length > 0
        ? { toolPackagePins: input.foldedBody.toolPackagePins }
        : {}),
    });
  return {
    runId: prepared.anchorRunId,
    address: prepared.deploymentAddress,
    sessionId,
  };
}

/**
 * Provisions a run against `input.definitionId`, sends `input.prompt`
 * as its opening mail, and resolves with the run's accumulated
 * `connector.reply` content once its opening turn's `message.run.ended`
 * bracket closes.
 *
 * No owning workbench_launch row and no Inbox delivery. The event
 * subscription unsubscribes exactly once, and `deps.undeploy` tears the
 * run down exactly once, on every exit path.
 */
export async function runOneShotFoldedPrompt(
  deps: OneShotRunnerDeps,
  input: OneShotPromptInput,
): Promise<OneShotReply> {
  const definitionRow = await deps.db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.id, input.definitionId),
      eq(workflowDefinition.tenantId, input.tenantId),
    ),
  });
  if (definitionRow === undefined || definitionRow.assetId === null) {
    throw new OneShotDefinitionNotFoundError(input.definitionId);
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
    where: eq(tenantTable.id, input.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`No tenant "${input.tenantId}"`);
  }

  const projection = await readDefinitionProjection(deps.db, definitionRow);
  const foldedBody = readFoldedBody(
    projection,
    definitionRow.grantRequirements,
  );

  const launched = await (deps.provision !== undefined
    ? deps.provision({
        tenantId: input.tenantId,
        principalId: input.principalId,
        definitionId: input.definitionId,
        foldedBody,
        domain: tenantRow.domain,
      })
    : provisionOnAsset(deps, {
        tenantId: input.tenantId,
        principalId: input.principalId,
        definitionAssetId: definitionRow.assetId,
        foldedBody,
        domain: tenantRow.domain,
      }));

  deps.lifecycle?.track(launched.address);
  deps.lifecycle?.recordActivity(launched.address);

  return new Promise<OneShotReply>((resolve, reject) => {
    let settled = false;
    let accumulated = "";

    const unsubscribe = deps.events.on(
      "agent.event",
      ({ agentAddress, event }) => {
        if (agentAddress !== launched.address || settled) return;

        const content = connectorReplyContent(event);
        if (content !== undefined) {
          accumulated += content;
          return;
        }

        const ended = messageRunEnded(event);
        if (ended === undefined) return;

        if (ended.status === "failed") {
          void settle("planning-run-failed", () => {
            reject(new FoldedRunFailedError(ended.errorMessage));
          });
          return;
        }
        void settle("planning-run-complete", () => {
          resolve({ content: accumulated, runId: launched.runId });
        });
      },
    );

    async function settle(reason: string, finish: () => void): Promise<void> {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      try {
        await deps.undeploy(launched.address, reason);
      } catch (err) {
        log.error`one-shot run ${launched.address}: undeploy failed during teardown (${reason}): ${
          err instanceof Error ? err.message : String(err)
        }`;
      }
      deps.lifecycle?.untrack(launched.address);
      finish();
    }

    const timer = setTimeout(() => {
      void settle("planning-run-timed-out", () => {
        reject(new FoldedRunTimedOutError(input.timeoutMs));
      });
    }, input.timeoutMs);

    void (async () => {
      try {
        const cryptoProvider = await deps.cryptoProviders.get(launched.runId);
        if (deps.sendMail !== undefined) {
          await deps.sendMail({
            tenantId: input.tenantId,
            sessionId: launched.sessionId,
            agentAddress: launched.address,
            from: `${input.principalId}@${tenantRow.domain}`,
            content: input.prompt,
            cryptoProvider,
          });
          return;
        }
        await deps.sessionService.sendUserMessage({
          agentAddress: launched.address,
          from: `${input.principalId}@${tenantRow.domain}`,
          messageId: `<${crypto.randomUUID()}@${tenantRow.domain}>`,
          date: new Date(),
          content: input.prompt,
          sessionId: launched.sessionId,
          tenantId: input.tenantId,
          cryptoProvider,
        });
      } catch (cause) {
        void settle("planning-run-send-failed", () => {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        });
      }
    })();
  });
}
