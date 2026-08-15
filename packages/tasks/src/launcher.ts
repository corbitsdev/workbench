// Launches a one-shot task: a prompt sent to an agent definition, no
// channel involved. Mirrors `@corbits/chat`'s `launchInvite` shape
// (definition lookup, `readFoldedBody`, `launchFoldedRun`) minus every
// channel/participant/settings concern — a task never creates a
// `channel_settings` row, so it can never appear in a chat sidebar.
//
// Model preference: today `launchFoldedRun` → `deployAtHead` resolves
// a run's inference source from the tenant catalog against the
// definition's own baked-in `foldedBody.model` — see
// `resolveDefinitionSources` in `vendor/intx/hub-api`, which is
// explicit that "a run's inference sources come from its definition
// resolved against the tenant catalog — never from the request body."
// There is no per-launch model override path for a real (non-noop)
// agent run short of a `SourcesOverride`, which bypasses catalog
// credential resolution entirely — reimplementing that here would
// violate "Interchange owns credential resolution." A task's
// `modelPreference` is therefore recorded on the row for display, but
// today's launch always resolves the definition's own catalog default,
// exactly like `launchInvite`. See the package README for this
// documented gap.
import { and, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { tenant as tenantTable, workflowDefinition } from "@intx/db/schema";
import {
  launchFoldedRun,
  readDefinitionJSON,
  readFoldedBody,
  sendFoldedMail,
  type FoldedRunsDeps,
} from "@corbits/folded-runs";
import type { CryptoProviderCache } from "@corbits/folded-runs";
import type { AgentLifecycle } from "@corbits/agent-lifecycle";
import { generateId } from "@intx/hub-common";
import { formatRunAddress } from "@intx/types";
import type { CryptoProvider } from "@intx/types/runtime";

import { task } from "./schema";
import type { TaskStore } from "./store";

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
  const foldedBody = readFoldedBody(definitionJSON);
  if (foldedBody.systemPrompt === "") {
    throw new TaskDefinitionNotLaunchableError(
      input.definitionId,
      "has no system prompt configured",
    );
  }

  const instanceId = generateId("workflowRun");
  const triggerAddress = formatRunAddress(instanceId, tenantRow.domain);
  const taskId = `task_${crypto.randomUUID().replace(/-/g, "")}`;

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
        createdAt: new Date(),
        completedAt: null,
      });
    },
  });

  deps.lifecycle?.track(triggerAddress);
  deps.lifecycle?.recordActivity(triggerAddress);

  const cryptoProvider: CryptoProvider = await deps.cryptoProviders.get(taskId);

  await sendFoldedMail(deps.foldedRuns, {
    tenantId: input.tenantId,
    sessionId: launched.sessionId,
    agentAddress: triggerAddress,
    from: `${input.principalId}@${tenantRow.domain}`,
    domain: tenantRow.domain,
    content: input.prompt,
    cryptoProvider,
  });

  deps.lifecycle?.recordActivity(triggerAddress);

  const record = await deps.store.getTaskByRunId(instanceId);
  if (record === null) {
    throw new Error(`task "${taskId}" was not persisted by its own launch`);
  }
  return record;
}
