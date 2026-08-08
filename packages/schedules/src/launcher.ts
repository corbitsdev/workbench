// The hub-side launch path a due schedule fires through. Built
// entirely from `@corbits/folded-runs` — the launch/mail machinery
// `@corbits/chat`'s `launchInvite`/`sendMail` already use for exactly
// this shape (deploy an interactive instance of an already-deployed
// workflow definition, then deliver it a message) — rather than a
// second implementation. This package never re-derives inference-source
// resolution, principal/session/run bookkeeping, or mail signing: all
// of that lives in `@corbits/folded-runs` and is reused verbatim.
//
// A schedule launches a fresh instance on every occurrence (never
// reuses a prior run): unlike a chat channel, a scheduled automation
// has no notion of an ongoing conversation to resume, so "launch, then
// deliver the input payload as its first mail" is the whole contract.
import { and, eq } from "drizzle-orm";
import {
  createCryptoProviderCache,
  domainOf,
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMail,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import { generateId } from "@intx/hub-common";
import { formatAgentAddress } from "@intx/types";
import type {
  AssetService,
  EventCollectorRegistry,
  SessionService,
  SidecarRouter,
} from "@intx/hub-sessions";

export interface LaunchScheduledRunInput {
  readonly tenantId: string;
  readonly scheduleId: string;
  readonly workflowDefinitionId: string;
  readonly createdBy: string;
  readonly input: unknown;
}

export interface LaunchedScheduledRun {
  readonly instanceId: string;
  readonly address: string;
}

/** The launch call surface `scheduler.ts` and the routes' "run now" action need from the hub. */
export interface ScheduleLauncher {
  launchScheduledRun(
    input: LaunchScheduledRunInput,
  ): Promise<LaunchedScheduledRun>;
}

export type CreateHubScheduleLauncherDeps = {
  db: DB["db"];
  sessionService: SessionService;
  assetService: AssetService;
  sidecarRouter: SidecarRouter;
  eventCollectors: EventCollectorRegistry;
};

/**
 * Composes `ScheduleLauncher` over the hub's real session services and
 * `@corbits/folded-runs`, mirroring `createHubChatPlatform`'s
 * `launchInvite` (see `packages/chat/src/platform-adapter.ts`)
 * definition-lookup and launch, then a `sendFoldedMail` call carrying
 * the schedule's `input` payload as the instance's first message —
 * the same "launch, then deliver" shape `POST .../invite` uses for a
 * chat's invited agent.
 */
export function createHubScheduleLauncher(
  deps: CreateHubScheduleLauncherDeps,
): ScheduleLauncher {
  const foldedRunsDeps: FoldedRunsDeps = {
    db: deps.db,
    sessionService: deps.sessionService,
    assetService: deps.assetService,
    sidecarRouter: deps.sidecarRouter,
    eventCollectors: deps.eventCollectors,
  };
  const cryptoProviders = createCryptoProviderCache();

  return {
    async launchScheduledRun(input): Promise<LaunchedScheduledRun> {
      const definitionRow = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.id, input.workflowDefinitionId),
          eq(workflowDefinition.tenantId, input.tenantId),
        ),
      });
      if (definitionRow === undefined) {
        throw new Error(
          `No definition "${input.workflowDefinitionId}" for this tenant`,
        );
      }
      if (definitionRow.status !== "deployed") {
        throw new Error(
          `Definition "${input.workflowDefinitionId}" is not in a ` +
            `launchable state (status: ${definitionRow.status})`,
        );
      }
      if (definitionRow.assetId === null) {
        throw new Error(
          `Definition "${input.workflowDefinitionId}" has not been materialized`,
        );
      }

      const tenantRow = await deps.db.query.tenant.findFirst({
        where: eq(tenantTable.id, input.tenantId),
      });
      if (tenantRow === undefined) {
        throw new Error(`No tenant "${input.tenantId}"`);
      }

      const definitionJSON = await readDefinitionJSON(
        deps.assetService,
        definitionRow.assetId,
      );
      const foldedBody = readFoldedBody(definitionJSON);
      if (foldedBody.systemPrompt === "") {
        throw new Error(
          `Definition "${input.workflowDefinitionId}" cannot be launched ` +
            "without a system prompt configured",
        );
      }

      const instanceId = generateId("instance");
      const triggerAddress = formatAgentAddress(instanceId, tenantRow.domain);

      const launched = await launchFoldedRun(foldedRunsDeps, {
        tenantId: input.tenantId,
        instanceId,
        triggerAddress,
        definitionId: input.workflowDefinitionId,
        foldedBody,
        launchLabel: "the scheduled run",
      });

      const domain = domainOf(triggerAddress);
      const cryptoProvider = await cryptoProviders.get(instanceId);
      await sendFoldedMail(foldedRunsDeps, {
        tenantId: input.tenantId,
        sessionId: launched.sessionId,
        agentAddress: triggerAddress,
        from: `${input.createdBy}@${domain}`,
        domain,
        content: JSON.stringify(input.input),
        cryptoProvider,
      });

      return { instanceId, address: triggerAddress };
    },
  };
}
