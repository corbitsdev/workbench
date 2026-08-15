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
//
// The `{create}` branch is the one path in this package that turns
// untrusted model output directly into a deployed, launchable agent
// definition, so it carries three fail-closed guards `{use}` needs
// none of (`{use}` only ever names an id `launchTask` itself already
// re-validates against the tenant and its own taskability gate):
//   1. Every REST-boundary bound `@corbits/agent-directory`'s own
//      `CreateAgentDefinitionInput` enforces on a hand-authored agent
//      (bounded non-blank name/systemPrompt, deduped skills) applies
//      here too, reused directly rather than re-implemented, plus a
//      cardinality+dedup bound on `toolPackagePins` that boundary has
//      no field for (`./create-bounds.ts`).
//   2. A `workflow-definition:*`/`create` grant, checked here rather
//      than at route-middleware time, since which branch a plan takes
//      is only known deep inside `dispatch`, after Myra's reply
//      resolves.
//   3. A real `CredentialBinding` for every credentialed tool package
//      pinned, resolved from the same inventory the plan was validated
//      against — a pin with no working credential is worse than no
//      pin at all: the agent would look capable and silently fail.
import { type } from "arktype";
import type { CredentialBinding } from "@intx/types";
import {
  launchTask,
  type TaskLauncherDeps,
  type TaskRecord,
  type TaskStore,
} from "@corbits/tasks";
import { CreateAgentDefinitionInput } from "@corbits/agent-directory";
import { BoundedDedupedToolPackageNameArray } from "./create-bounds";
import { plannerCreatedDefinitionHandle } from "./planner-created-naming";
import type { PlannerInventory } from "./inventory";
import type { TaskSpec } from "./task-spec";

export class PlannerCreateBoundsViolationError extends Error {
  constructor(reason: string) {
    super(`Myra's plan to create an agent violated a bound: ${reason}`);
    this.name = "PlannerCreateBoundsViolationError";
  }
}

export class PlannerCredentialBindingUnavailableError extends Error {
  constructor(toolPackageName: string) {
    super(
      `No credential binding is available for tool package ` +
        `"${toolPackageName}" — refusing to deploy an agent whose ` +
        "granted tool couldn't actually work",
    );
    this.name = "PlannerCredentialBindingUnavailableError";
  }
}

export class PlannerDefinitionGrantDeniedError extends Error {
  constructor(principalId: string) {
    super(
      `Principal "${principalId}" is not permitted to have Myra create ` +
        "new agent definitions",
    );
    this.name = "PlannerDefinitionGrantDeniedError";
  }
}

export type SpawnDeps = {
  readonly taskLauncherDeps: TaskLauncherDeps;
  readonly store: TaskStore;
  readonly deployAgentDefinition: (input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    readonly handle: string;
    readonly systemPrompt: string;
    readonly toolPackagePins: readonly string[];
    readonly skills: readonly string[];
    readonly credentialBindings: readonly CredentialBinding[];
    readonly model?: string;
  }) => Promise<{ readonly definitionId: string }>;
  /**
   * Checked only on the `{create}` branch, before `deployAgentDefinition`
   * — the `{use}` branch needs no extra grant, since `launchTask` itself
   * already gates on whatever `task:*`/`create` proved at the route
   * boundary. Throws `PlannerDefinitionGrantDeniedError` when denied.
   */
  readonly requireDefinitionCreateGrant: (input: {
    readonly tenantId: string;
    readonly principalId: string;
  }) => Promise<void>;
};

export type SpawnFromTaskSpecInput = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly spec: TaskSpec;
  readonly plannerRunId: string;
  /** The exact inventory the spec was validated against — never a copy
   * fetched fresh, so a `{create}` branch's tool-package pins resolve
   * against the same credential bindings the plan was offered, not a
   * potentially-widened view fetched after the fact. */
  readonly inventory: PlannerInventory;
};

/** Resolves the `{create}` branch's `toolPackagePins` into the
 * `CredentialBinding`s `deployAgentDefinition` must grant for each pin
 * to actually work at runtime. Every pin is already proven to be a
 * member of `inventory.toolPackages` by
 * `validateTaskSpecAgainstInventory`; the lookup below is defense in
 * depth, not the primary check — a pin that somehow isn't found there
 * fails closed rather than deploying with a silently-dropped pin. */
function resolveCredentialBindings(
  toolPackagePins: readonly string[],
  inventory: PlannerInventory,
): readonly CredentialBinding[] {
  const byName = new Map(
    inventory.toolPackages.map((entry) => [entry.name, entry]),
  );
  const bindings: CredentialBinding[] = [];
  for (const pin of toolPackagePins) {
    const entry = byName.get(pin);
    if (entry === undefined) {
      throw new PlannerCredentialBindingUnavailableError(pin);
    }
    if (entry.credentialBinding !== null) {
      bindings.push(entry.credentialBinding);
    }
  }
  return bindings;
}

/** Validates `spec.create` through the same bounds
 * `@corbits/agent-directory`'s REST boundary enforces on a
 * hand-authored agent, plus this package's own `toolPackagePins`
 * bound. Throws `PlannerCreateBoundsViolationError` on any violation —
 * never deploys, never silently truncates. Returns the handle the
 * definition will deploy under. */
function validateCreateBounds(
  create: Extract<TaskSpec, { create: unknown }>["create"],
): { readonly handle: string } {
  const handle = plannerCreatedDefinitionHandle(create.name);

  const restShape = CreateAgentDefinitionInput({
    name: create.name,
    handle,
    systemPrompt: create.systemPrompt,
    skills: create.skills,
    ...(create.modelPreference !== undefined
      ? { model: create.modelPreference }
      : {}),
  });
  if (restShape instanceof type.errors) {
    throw new PlannerCreateBoundsViolationError(restShape.summary);
  }

  const toolPackagePins = BoundedDedupedToolPackageNameArray(
    create.toolPackagePins,
  );
  if (toolPackagePins instanceof type.errors) {
    throw new PlannerCreateBoundsViolationError(toolPackagePins.summary);
  }

  return { handle };
}

export async function spawnFromTaskSpec(
  deps: SpawnDeps,
  input: SpawnFromTaskSpecInput,
): Promise<TaskRecord> {
  const spec = input.spec;
  const definitionId =
    "use" in spec
      ? spec.use
      : await (async () => {
          const create = spec.create;
          const { handle } = validateCreateBounds(create);
          await deps.requireDefinitionCreateGrant({
            tenantId: input.tenantId,
            principalId: input.principalId,
          });
          const credentialBindings = resolveCredentialBindings(
            create.toolPackagePins,
            input.inventory,
          );
          const deployed = await deps.deployAgentDefinition({
            tenantId: input.tenantId,
            principalId: input.principalId,
            name: create.name,
            handle,
            systemPrompt: create.systemPrompt,
            toolPackagePins: create.toolPackagePins,
            skills: create.skills,
            credentialBindings,
            ...(create.modelPreference !== undefined
              ? { model: create.modelPreference }
              : {}),
          });
          return deployed.definitionId;
        })();

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
