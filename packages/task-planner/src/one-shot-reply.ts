// A synchronous wrapper around one folded run's opening turn: launch,
// send the prompt, wait for exactly one reply, tear down the
// subscription. No precedent for this shape exists elsewhere in the
// codebase — `@corbits/tasks`' `launchTask` launches and returns
// immediately (its reply lands asynchronously, via
// `createTaskOrchestrator`'s subscription to the same event stream);
// this module is the one place that turns that same event stream into
// an awaitable promise, for a caller that has no Inbox and no task row
// to hang a later delivery on. `runPlanner` (`./planner-run.ts`) is
// that caller: a planning prompt isn't a task, so it must resolve in
// the same request/response cycle that asked for it.
import { and, eq } from "drizzle-orm";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import {
  connectorReplyContent,
  launchFoldedRun,
  messageRunEnded,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMailWithRetry,
  type CryptoProviderCache,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import { generateId } from "@intx/hub-common";
import type { SidecarEventEmitter } from "@intx/hub-sessions";
import { formatRunAddress } from "@intx/types";
import type { FoldedBody } from "@intx/workflow-deploy";

export type OneShotReply = {
  readonly content: string;
  readonly runId: string;
};

export type OneShotRunnerDeps = {
  readonly foldedRuns: FoldedRunsDeps;
  readonly events: SidecarEventEmitter;
  readonly cryptoProviders: CryptoProviderCache;
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

export class PlannerRunTimedOutError extends Error {
  constructor(timeoutMs: number) {
    super(`the planning run did not reply within ${String(timeoutMs)}ms`);
    this.name = "PlannerRunTimedOutError";
  }
}

export class PlannerRunFailedError extends Error {
  constructor(errorMessage: string | undefined) {
    super(
      errorMessage !== undefined
        ? `the planning run failed: ${errorMessage}`
        : "the planning run failed",
    );
    this.name = "PlannerRunFailedError";
  }
}

/**
 * Launches a folded run against `input.definitionId`, sends
 * `input.prompt` as its opening mail, and resolves with the run's
 * accumulated `connector.reply` content once its opening turn's
 * `message.run.ended` bracket closes — or rejects with
 * `PlannerRunFailedError` (the run itself ended `"failed"`) or
 * `PlannerRunTimedOutError` (`input.timeoutMs` elapsed first).
 *
 * Deliberately bypasses `@corbits/tasks`' `launchTask`: this run gets
 * no `task` row and no Inbox delivery — a planning prompt is not a
 * task, so `launchFoldedRun` is called directly with no `persistExtra`.
 * The event subscription always unsubscribes exactly once, on every
 * exit path (success, run failure, timeout), so a caller that runs
 * many planning prompts in one process never leaks listeners.
 */
export async function runOneShotFoldedPrompt(
  deps: OneShotRunnerDeps,
  input: OneShotPromptInput,
): Promise<OneShotReply> {
  const definitionRow =
    await deps.foldedRuns.db.query.workflowDefinition.findFirst({
      where: and(
        eq(workflowDefinition.id, input.definitionId),
        eq(workflowDefinition.tenantId, input.tenantId),
      ),
    });
  if (definitionRow === undefined || definitionRow.assetId === null) {
    throw new OneShotDefinitionNotFoundError(input.definitionId);
  }

  const tenantRow = await deps.foldedRuns.db.query.tenant.findFirst({
    where: eq(tenantTable.id, input.tenantId),
  });
  if (tenantRow === undefined) {
    throw new Error(`No tenant "${input.tenantId}"`);
  }

  const definitionJSON = await readDefinitionJSON(
    deps.foldedRuns.assetService,
    definitionRow.assetId,
  );
  const definitionBody = readFoldedBody(definitionJSON);
  const foldedBody: FoldedBody = {
    systemPrompt: definitionBody.systemPrompt,
    toolPackagePins: definitionBody.toolPackagePins,
    grantRequirements: definitionBody.grantRequirements,
    credentialBindings: definitionBody.credentialBindings,
    model: definitionBody.model,
  };

  const instanceId = generateId("workflowRun");
  const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);

  const launched = await launchFoldedRun(deps.foldedRuns, {
    tenantId: input.tenantId,
    instanceId,
    triggerAddress,
    definitionId: input.definitionId,
    foldedBody,
    launchLabel: "the planning run",
  });

  return new Promise<OneShotReply>((resolve, reject) => {
    let settled = false;
    let accumulated = "";

    const unsubscribe = deps.events.on(
      "agent.event",
      ({ agentAddress, event }) => {
        if (agentAddress !== triggerAddress || settled) return;

        const content = connectorReplyContent(event);
        if (content !== undefined) {
          accumulated += content;
          return;
        }

        const ended = messageRunEnded(event);
        if (ended === undefined) return;

        settle(() => {
          if (ended.status === "failed") {
            reject(new PlannerRunFailedError(ended.errorMessage));
            return;
          }
          resolve({ content: accumulated, runId: instanceId });
        });
      },
    );

    function settle(finish: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      finish();
    }

    const timer = setTimeout(() => {
      settle(() => {
        reject(new PlannerRunTimedOutError(input.timeoutMs));
      });
    }, input.timeoutMs);

    void (async () => {
      const cryptoProvider = await deps.cryptoProviders.get(instanceId);
      const sent = await sendFoldedMailWithRetry(deps.foldedRuns, {
        tenantId: input.tenantId,
        sessionId: launched.sessionId,
        agentAddress: triggerAddress,
        from: `${input.principalId}@${tenantRow.domain}`,
        domain: tenantRow.domain,
        content: input.prompt,
        cryptoProvider,
      });
      if (!sent.ok) {
        settle(() => {
          reject(
            sent.error instanceof Error
              ? sent.error
              : new Error(String(sent.error)),
          );
        });
      }
    })();
  });
}
