// Dispatches a validated `TaskSpec` exactly the way a manually-launched
// task is dispatched: `{use}` calls `launchTask` directly against the
// named agent; `{create}` deploys a brand-new agent definition first
// (through the host-injected `deployAgentDefinition`, which wraps
// `@corbits/agent-directory`'s sanctioned deploy path — see
// `./agent-workflow-input.ts`) and then launches against the result.
// Both branches link the launched task back to the planner run that
// chose its agent, so "why this agent?" (`MyraChoiceSummary` in
// `@corbits/tasks-ui`) has something to point at. Any `launchTask`
// failure propagates unchanged — this module adds nothing that could
// weaken `@corbits/tasks`' own fail-closed error classes.
import {
  launchTask,
  type TaskLauncherDeps,
  type TaskRecord,
  type TaskStore,
} from "@corbits/tasks";
import type { TaskSpec } from "./task-spec";

export type SpawnDeps = {
  readonly taskLauncherDeps: TaskLauncherDeps;
  readonly store: TaskStore;
  readonly deployAgentDefinition: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly systemPrompt: string;
    readonly toolPackagePins: readonly string[];
    readonly skills: readonly string[];
    readonly model?: string;
  }) => Promise<{ readonly definitionId: string }>;
};

export type SpawnFromTaskSpecInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly spec: TaskSpec;
  readonly plannerRunId: string;
};

export async function spawnFromTaskSpec(
  deps: SpawnDeps,
  input: SpawnFromTaskSpecInput,
): Promise<TaskRecord> {
  const definitionId =
    "use" in input.spec
      ? input.spec.use
      : (
          await deps.deployAgentDefinition({
            tenantId: input.tenantId,
            principalId: input.principalId,
            name: input.spec.create.name,
            systemPrompt: input.spec.create.systemPrompt,
            toolPackagePins: input.spec.create.toolPackagePins,
            skills: input.spec.create.skills,
            ...(input.spec.create.modelPreference !== undefined
              ? { model: input.spec.create.modelPreference }
              : {}),
          })
        ).definitionId;

  const record = await launchTask(deps.taskLauncherDeps, {
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId,
    prompt: input.spec.refinedOutcome,
    ...("create" in input.spec &&
    input.spec.create.modelPreference !== undefined
      ? { modelPreference: input.spec.create.modelPreference }
      : {}),
  });

  await deps.store.linkPlannerRun({
    tenantId: input.tenantId,
    id: record.id,
    plannerRunId: input.plannerRunId,
  });

  return { ...record, plannerRunId: input.plannerRunId };
}
