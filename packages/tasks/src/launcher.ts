// Launches a one-shot task: a prompt sent to an agent definition, no
// channel involved. Mirrors `@corbits/chat`'s `launchInvite` shape
// (definition lookup, `readFoldedBody`, `launchFoldedRun`) minus every
// channel/participant/settings concern — a task never creates a
// `channel_settings` row, so it can never appear in a chat sidebar.
//
// Model preference: a task's chosen catalog model rides the launch
// body's own `model` field — the exact seam a definition's declared
// model already uses. `launchFoldedRun` → `deployAtHead` resolves
// `foldedBody.model` against the tenant catalog via
// `resolveDefinitionSources` (`fallbackModel`), with full
// credential-ownership checks — never a `SourcesOverride`, which would
// bypass the catalog entirely. No preference means the definition's
// own baked-in model, exactly like `launchInvite`.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import {
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMailWithRetry,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import type { CryptoProviderCache } from "@corbits/folded-runs";
import type { AgentLifecycle } from "@corbits/agent-lifecycle";
import {
  deliverTaskResultMail,
  type NotifyDeliveryDeps,
} from "@corbits/notify";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { formatRunAddress } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";
import type { FoldedBody } from "@intx/workflow-deploy";

import { task, taskLeg } from "./schema";
import { taskLegLaunchRows, type TaskLegSpec, type TaskStore } from "./store";

const log = getLogger(["tasks", "launcher"]);

export const PROMPT_DELIVERY_FAILED_MESSAGE =
  "The task started, but its instructions couldn't be delivered. Try again.";

export class TaskDefinitionNotFoundError extends Error {
  constructor(definitionId: string) {
    super(`No definition "${definitionId}" for this tenant`);
    this.name = "TaskDefinitionNotFoundError";
  }
}

export class TaskDefinitionNotLaunchableError extends Error {
  constructor(definitionId: string, reason: string) {
    super(`Definition "${definitionId}" is not launchable: ${reason}`);
    this.name = "TaskDefinitionNotLaunchableError";
  }
}

export class TaskDefinitionNotTaskableError extends Error {
  constructor(definitionId: string) {
    super(
      `Definition "${definitionId}" is not offered for tasks (it is an ` +
        "automation or plumbing definition, not a conversational agent)",
    );
    this.name = "TaskDefinitionNotTaskableError";
  }
}

/** The leg's launch claim was taken by someone else (or already
 * settled) between claiming it and committing its run. */
export class TaskLegClaimLostError extends Error {
  constructor(legId: string) {
    super(`Leg "${legId}" is no longer claimed for launch`);
    this.name = "TaskLegClaimLostError";
  }
}

export type TaskLauncherDeps = {
  db: DB["db"];
  store: TaskStore;
  foldedRuns: FoldedRunsDeps;
  cryptoProviders: CryptoProviderCache;
  /** Delivers the honest failure inbox item when the opening prompt
   * can't reach an already-launched run — same delivery bundle the
   * task orchestrator writes results through. */
  notify: NotifyDeliveryDeps;
  /**
   * The host's verdict on whether a deployed definition belongs in
   * the task picker — mirrors `@corbits/chat`'s `isInvitableDefinition`
   * seam exactly. Required, never defaulted: an unfiltered picker
   * would let automations and channel-host plumbing masquerade as
   * task-launchable agents.
   */
  isTaskableDefinition: (definition: { id: string; name: string }) => boolean;
  /** Same idle-sleep lifecycle chat drives — optional, since a host
   * that hasn't wired lifecycle tracking yet still gets a working
   * launch, just without idle-sleep bookkeeping. */
  lifecycle?: Pick<AgentLifecycle, "track" | "recordActivity">;
};

export type LaunchTaskInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference?: string;
  /**
   * Agents this task hands its work on to after the first, in order.
   * Absent or empty means a single-agent task — the shape every task
   * had before chains existed.
   */
  readonly followOn?: readonly TaskLegSpec[];
};

/**
 * Everything a launch needs from the tenant's own rows, resolved once
 * and shared by the opening leg and every hand-off after it. Throws
 * the same fail-closed error classes whichever leg asked, so a
 * hand-off to a since-undeployed agent fails as loudly as a first
 * launch would.
 */
async function resolveLaunchTarget(
  deps: TaskLauncherDeps,
  input: { tenantId: string; definitionId: string; modelPreference?: string },
): Promise<{
  definitionRow: { id: string; name: string };
  domain: string;
  foldedBody: FoldedBody;
}> {
  const definitionRow = await deps.db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.id, input.definitionId),
      eq(workflowDefinition.tenantId, input.tenantId),
    ),
  });
  if (definitionRow === undefined) {
    throw new TaskDefinitionNotFoundError(input.definitionId);
  }
  if (definitionRow.status !== "deployed") {
    throw new TaskDefinitionNotLaunchableError(
      input.definitionId,
      `status is "${definitionRow.status}", not "deployed"`,
    );
  }
  if (definitionRow.assetId === null) {
    throw new TaskDefinitionNotLaunchableError(
      input.definitionId,
      "has not been materialized",
    );
  }
  if (!deps.isTaskableDefinition(definitionRow)) {
    throw new TaskDefinitionNotTaskableError(input.definitionId);
  }

  const tenantRow = await deps.db.query.tenant.findFirst({
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
  if (definitionBody.systemPrompt === "") {
    throw new TaskDefinitionNotLaunchableError(
      input.definitionId,
      "has no system prompt configured",
    );
  }
  // The picked catalog model replaces the definition's own declared
  // model for THIS launch only — `deployAtHead` resolves
  // `foldedBody.model` against the tenant catalog (`fallbackModel` in
  // `resolveDefinitionSources`), so the preference pins the run's real
  // source chain through the same credential-checked path a
  // definition's baked-in model uses.
  const foldedBody: FoldedBody = {
    systemPrompt: definitionBody.systemPrompt,
    toolPackagePins: definitionBody.toolPackagePins,
    grantRequirements: definitionBody.grantRequirements,
    credentialBindings: definitionBody.credentialBindings,
    model: input.modelPreference ?? definitionBody.model,
  };

  return {
    definitionRow: { id: definitionRow.id, name: definitionRow.name },
    domain: tenantRow.domain,
    foldedBody,
  };
}

type LaunchRunInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference?: string;
  readonly domain: string;
  readonly foldedBody: FoldedBody;
  readonly instanceId: string;
  /** Keys this launch's signing provider — the task id for an opening
   * leg, the leg id for a hand-off. */
  readonly cryptoKey: string;
  readonly persistExtra: (
    tx: Parameters<
      NonNullable<Parameters<typeof launchFoldedRun>[1]["persistExtra"]>
    >[0],
  ) => Promise<void>;
};

type LaunchRunOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly attempts: number; readonly error: unknown };

/**
 * The launch core one leg needs: write the run rows (plus the caller's
 * own row, atomically), deploy, then send the opening prompt. The
 * prompt send is reported rather than thrown, because the run and the
 * caller's row are already committed by the time it runs — each caller
 * decides how to settle that honestly.
 */
async function launchRun(
  deps: TaskLauncherDeps,
  input: LaunchRunInput,
): Promise<LaunchRunOutcome> {
  const triggerAddress = formatRunAddress(input.instanceId, input.domain);

  const launched = await launchFoldedRun(deps.foldedRuns, {
    tenantId: input.tenantId,
    instanceId: input.instanceId,
    triggerAddress,
    definitionId: input.definitionId,
    foldedBody: input.foldedBody,
    launchLabel: "the task agent",
    persistExtra: input.persistExtra,
  });

  deps.lifecycle?.track(triggerAddress);
  deps.lifecycle?.recordActivity(triggerAddress);

  const cryptoProvider: CryptoProvider = await deps.cryptoProviders.get(
    input.cryptoKey,
  );

  const sent = await sendFoldedMailWithRetry(deps.foldedRuns, {
    tenantId: input.tenantId,
    sessionId: launched.sessionId,
    agentAddress: triggerAddress,
    from: `${input.principalId}@${input.domain}`,
    domain: input.domain,
    content: input.prompt,
    cryptoProvider,
  });

  if (!sent.ok) {
    return { ok: false, attempts: sent.attempts, error: sent.error };
  }

  deps.lifecycle?.recordActivity(triggerAddress);
  return { ok: true };
}

// Hand-rolled prefix: `@intx/hub-common`'s `generateId` has no "task"
// kind, and its PREFIXES map is closed — [Intx gap] CL-6056 tracks
// adding one. Same 16-byte hex body `generateId` mints.
function mintTaskId(): string {
  return `task_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function launchTask(
  deps: TaskLauncherDeps,
  input: LaunchTaskInput,
) {
  const target = await resolveLaunchTarget(deps, input);
  const instanceId = generateId("workflowRun");
  const taskId = mintTaskId();
  const createdAt = new Date();
  const followOn = input.followOn ?? [];

  const outcome = await launchRun(deps, {
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId: input.definitionId,
    prompt: input.prompt,
    ...(input.modelPreference !== undefined
      ? { modelPreference: input.modelPreference }
      : {}),
    domain: target.domain,
    foldedBody: target.foldedBody,
    instanceId,
    cryptoKey: taskId,
    persistExtra: async (tx) => {
      await tx.insert(task).values({
        id: taskId,
        tenantId: input.tenantId,
        principalId: input.principalId,
        definitionId: input.definitionId,
        agentName: definitionRow.name,
        prompt: input.prompt,
        modelPreference: input.modelPreference ?? null,
        status: "running",
        runId: instanceId,
        resultMailId: null,
        createdAt,
        completedAt: null,
      });
      await tx.insert(taskLeg).values(
        taskLegLaunchRows(
          {
            id: taskId,
            tenantId: input.tenantId,
            principalId: input.principalId,
            definitionId: input.definitionId,
            prompt: input.prompt,
            modelPreference: input.modelPreference ?? null,
            runId: instanceId,
            followOn,
          },
          createdAt,
        ),
      );
    },
  });

  if (!outcome.ok) {
    // The run, the task row and its legs are already committed —
    // throwing here would 422 the request while leaving a promptless
    // "running" zombie behind. Settle the task honestly instead: flip
    // it to failed, tell the person in their Inbox, and return the
    // failed record so the caller sees exactly what the store now says.
    log.error`task ${taskId}: opening prompt failed after ${String(
      outcome.attempts,
    )} attempts: ${
      outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error)
    }`;
    const completedAt = new Date();
    await deps.store.completeTask({
      tenantId: input.tenantId,
      id: taskId,
      status: "failed",
      completedAt,
    });
    const report = await deliverTaskResultMail(deps.notify, {
      kind: "task-result",
      tenantId: input.tenantId,
      taskId,
      runIds: [instanceId],
      stepCount: followOn.length + 1,
      agentName: target.definitionRow.name,
      status: "failed",
      errorMessage: PROMPT_DELIVERY_FAILED_MESSAGE,
      elapsedMs: completedAt.getTime() - createdAt.getTime(),
      artifacts: [],
      recipients: [
        { tenantId: input.tenantId, principalId: input.principalId },
      ],
      createdAt: completedAt.toISOString(),
    });
    const mailId = report.deliveredMailboxRowIds[0];
    if (mailId !== undefined) {
      await deps.store.recordResultMail({
        tenantId: input.tenantId,
        id: taskId,
        resultMailId: mailId,
      });
    }
    const failed = await deps.store.getTask(input.tenantId, taskId);
    if (failed === null) {
      throw new Error(`task "${taskId}" was not persisted by its own launch`);
    }
    return failed;
  }

  const record = await deps.store.getTaskByRunId(instanceId);
  if (record === null) {
    throw new Error(`task "${taskId}" was not persisted by its own launch`);
  }
  return record;
}

export type LaunchTaskLegInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly legId: string;
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference: string | null;
};

/**
 * Launches one hand-off leg of an already-running task. Two writes, in
 * this order, because they answer two different questions:
 *
 *   - the run id is stamped inside the launch transaction, while the
 *     leg is still `dispatching` — a crash between committing the run
 *     and recording it would leave the leg claimable again, and the
 *     redelivered claim would launch a SECOND agent for work the first
 *     one is already doing;
 *   - the leg only becomes `running` after the opening prompt has been
 *     delivered. Until then the agent has been created but told
 *     nothing, so the leg stays in the one state the chain's failure
 *     path can settle — a leg marked `running` on the strength of a
 *     send that then failed would sit there forever, and the person
 *     would be told their work stopped at an agent that never ran.
 *
 * Both writes are conditional on `status = 'dispatching'`, the same
 * winner-takes-all guard the task's own terminal flip uses.
 */
export async function launchTaskLeg(
  deps: TaskLauncherDeps,
  input: LaunchTaskLegInput,
): Promise<string> {
  const target = await resolveLaunchTarget(deps, {
    tenantId: input.tenantId,
    definitionId: input.definitionId,
    ...(input.modelPreference !== null
      ? { modelPreference: input.modelPreference }
      : {}),
  });
  const instanceId = generateId("workflowRun");

  const outcome = await launchRun(deps, {
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId: input.definitionId,
    prompt: input.prompt,
    ...(input.modelPreference !== null
      ? { modelPreference: input.modelPreference }
      : {}),
    domain: target.domain,
    foldedBody: target.foldedBody,
    instanceId,
    cryptoKey: input.legId,
    persistExtra: async (tx) => {
      const stamped = await tx
        .update(taskLeg)
        .set({ runId: instanceId })
        .where(
          and(
            eq(taskLeg.id, input.legId),
            eq(taskLeg.tenantId, input.tenantId),
            eq(taskLeg.status, "dispatching"),
          ),
        )
        .returning();
      if (stamped.length === 0) {
        throw new TaskLegClaimLostError(input.legId);
      }
    },
  });

  if (!outcome.ok) {
    throw new Error(
      `the next agent's instructions couldn't be delivered after ` +
        `${String(outcome.attempts)} attempts: ${
          outcome.error instanceof Error
            ? outcome.error.message
            : String(outcome.error)
        }`,
      { cause: outcome.error },
    );
  }

  const started = await deps.store.confirmLegDelivery({
    tenantId: input.tenantId,
    legId: input.legId,
  });
  if (started === null) throw new TaskLegClaimLostError(input.legId);

  return instanceId;
}
