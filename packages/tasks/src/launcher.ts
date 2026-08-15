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

import { task } from "./schema";
import type { TaskStore } from "./store";

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
};

export async function launchTask(
  deps: TaskLauncherDeps,
  input: LaunchTaskInput,
) {
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

  const instanceId = generateId("workflowRun");
  const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);
  // Hand-rolled prefix: `@intx/hub-common`'s `generateId` has no "task"
  // kind, and its PREFIXES map is closed — [Intx gap] CL-6056 tracks
  // adding one. Same 16-byte hex body `generateId` mints.
  const taskId = `task_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdAt = new Date();

  const launched = await launchFoldedRun(deps.foldedRuns, {
    tenantId: input.tenantId,
    instanceId,
    triggerAddress,
    definitionId: input.definitionId,
    foldedBody,
    launchLabel: "the task agent",
    persistExtra: async (tx) => {
      await tx.insert(task).values({
        id: taskId,
        tenantId: input.tenantId,
        principalId: input.principalId,
        definitionId: input.definitionId,
        prompt: input.prompt,
        modelPreference: input.modelPreference ?? null,
        status: "running",
        runId: instanceId,
        resultMailId: null,
        createdAt,
        completedAt: null,
      });
    },
  });

  deps.lifecycle?.track(triggerAddress);
  deps.lifecycle?.recordActivity(triggerAddress);

  const cryptoProvider: CryptoProvider = await deps.cryptoProviders.get(taskId);

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
    // The run and the task row are already committed — throwing here
    // would 422 the request while leaving a promptless "running"
    // zombie behind. Settle the task honestly instead: flip it to
    // failed, tell the person in their Inbox, and return the failed
    // record so the caller sees exactly what the store now says.
    log.error`task ${taskId}: opening prompt failed after ${String(
      sent.attempts,
    )} attempts: ${
      sent.error instanceof Error ? sent.error.message : String(sent.error)
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
      runId: instanceId,
      agentName: definitionRow.name,
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

  deps.lifecycle?.recordActivity(triggerAddress);

  const record = await deps.store.getTaskByRunId(instanceId);
  if (record === null) {
    throw new Error(`task "${taskId}" was not persisted by its own launch`);
  }
  return record;
}
