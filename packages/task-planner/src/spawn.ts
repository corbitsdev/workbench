// Dispatches a validated `TaskSpec` exactly the way a manually-launched
// task is dispatched: `{use}` calls `launchTask` directly against the
// named agent; `{create}` deploys a brand-new agent definition first
// (through the host-injected `deployAgentDefinition`, which wraps
// `@corbits/agent-directory`'s sanctioned deploy path — see
// `./agent-workflow-input.ts`) and then launches against the result. A
// `{kind: "chain"}` spec resolves every step's definition the same way,
// all of them up front, then launches the whole run as ONE task with
// the chain machinery's own leg contract (`launchTask`'s `followOn` —
// see `@corbits/tasks`' `launcher.ts`/`chain.ts`): step 1 launches now,
// steps 2..N are written as `pending` legs `advanceChain` hands the
// work to, one at a time, as each prior leg settles. Every branch links
// the launched task back to the planner run that chose its agent(s), so
// "why this agent?" (`MyraChoiceSummary` in `@corbits/tasks-ui`) has
// something to point at. Any `launchTask` failure propagates unchanged
// — this module adds nothing that could weaken `@corbits/tasks`' own
// fail-closed error classes.
//
// A `{create}` step is the one path in this package that turns
// untrusted model output directly into a deployed, launchable agent
// definition, so it carries three fail-closed guards a `{use}` step
// needs none of (`{use}` only ever names an id `launchTask` itself
// already re-validates against the tenant and its own taskability
// gate):
//   1. Every REST-boundary bound `@corbits/agent-directory`'s own
//      `CreateAgentDefinitionInput` enforces on a hand-authored agent
//      (bounded non-blank name/systemPrompt, deduped skills) applies
//      here too, reused directly rather than re-implemented, plus a
//      cardinality+dedup bound on `toolPackagePins` that boundary has
//      no field for (`./create-bounds.ts`).
//   2. A `workflow-definition:*`/`create` grant, checked here rather
//      than at route-middleware time, since which branch (or which
//      steps, for a chain) a plan takes is only known deep inside
//      `dispatch`, after Myra's reply resolves — checked exactly ONCE
//      per spawn, before any step deploys, whether one step needs it or
//      every step does.
//   3. A real `CredentialBinding` for every credentialed tool package
//      pinned, resolved from the same inventory the plan was validated
//      against — a pin with no working credential is worse than no
//      pin at all: the agent would look capable and silently fail.
//
// A chain spawn is all-or-nothing: every step's bounds and credential
// bindings are validated before ANY of them deploys, and if a later
// step's deploy call itself fails, every definition THIS spawn already
// deployed is undeployed before the error propagates — never a chain
// left half-provisioned with agents nothing will ever launch.
import { type } from "arktype";
import type { CredentialBinding } from "@intx/types";
import {
  launchTask,
  type TaskLauncherDeps,
  type TaskLegSpec,
  type TaskRecord,
  type TaskStore,
} from "@corbits/tasks";
import { CreateAgentDefinitionInput } from "@corbits/agent-directory";
import { BoundedDedupedToolPackageNameArray } from "./create-bounds";
import { plannerCreatedDefinitionHandle } from "./planner-created-naming";
import type { PlannerInventory } from "./inventory";
import type { TaskSpec, TaskStep } from "./task-spec";

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
   * Checked only when at least one step in the spec takes a `{create}`
   * path, before any `deployAgentDefinition` call — a `{use}` step needs
   * no extra grant, since `launchTask` itself already gates on whatever
   * `task:*`/`create` proved at the route boundary. Throws
   * `PlannerDefinitionGrantDeniedError` when denied.
   */
  readonly requireDefinitionCreateGrant: (input: {
    readonly tenantId: string;
    readonly principalId: string;
  }) => Promise<void>;
  /**
   * The chain spawn's cleanup half: undoes a `deployAgentDefinition`
   * call this same spawn just made, when a LATER step in the same
   * chain fails to validate or deploy. Never called for a single-task
   * `{create}` spec — that branch's pre-existing behavior (a deployed
   * definition surviving a subsequent `launchTask` failure) is
   * unchanged; only a chain's own all-or-nothing guarantee needs this.
   */
  readonly undeployAgentDefinition: (input: {
    readonly tenantId: string;
    readonly definitionId: string;
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

  const restShapeBase = {
    name: create.name,
    handle,
    systemPrompt: create.systemPrompt,
    skills: create.skills,
  };
  const restShape = CreateAgentDefinitionInput(
    create.modelPreference !== undefined
      ? { ...restShapeBase, model: create.modelPreference }
      : restShapeBase,
  );
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

type ResolvedChainStep =
  | {
      readonly kind: "use";
      readonly definitionId: string;
      readonly prompt: string;
    }
  | {
      readonly kind: "create";
      readonly handle: string;
      readonly create: Extract<TaskStep, { create: unknown }>["create"];
      readonly credentialBindings: readonly CredentialBinding[];
      readonly prompt: string;
    };

/** Validates every step of a chain spec — bounds and credential-binding
 * resolution only, no network call, no deploy — before any step
 * deploys. Throws on the first invalid step, in step order, the same
 * `PlannerCreateBoundsViolationError`/`PlannerCredentialBindingUnavailableError`
 * a single `{create}` task would throw for its own one step. */
function resolveChainSteps(
  steps: readonly TaskStep[],
  inventory: PlannerInventory,
): readonly ResolvedChainStep[] {
  return steps.map((step) => {
    if ("use" in step) {
      return {
        kind: "use",
        definitionId: step.use,
        prompt: step.refinedOutcome,
      };
    }
    const { handle } = validateCreateBounds(step.create);
    const credentialBindings = resolveCredentialBindings(
      step.create.toolPackagePins,
      inventory,
    );
    return {
      kind: "create",
      handle,
      create: step.create,
      credentialBindings,
      prompt: step.refinedOutcome,
    };
  });
}

type ChainLeg = {
  readonly definitionId: string;
  readonly prompt: string;
  readonly modelPreference?: string;
};

/** Deploys every `{create}` step's definition, in step order, once
 * every step has already validated clean (`resolveChainSteps`). Every
 * `{use}` step passes through untouched. All-or-nothing: if a LATER
 * step's `deployAgentDefinition` call itself fails, every definition
 * this call already deployed is undeployed before the error
 * propagates — a chain is never left half-provisioned with agents
 * nothing will ever launch. */
async function deployChainSteps(
  deps: SpawnDeps,
  input: { readonly tenantId: string; readonly principalId: string },
  resolved: readonly ResolvedChainStep[],
): Promise<readonly ChainLeg[]> {
  const deployedDefinitionIds: string[] = [];
  try {
    const legs: ChainLeg[] = [];
    for (const step of resolved) {
      if (step.kind === "use") {
        legs.push({ definitionId: step.definitionId, prompt: step.prompt });
        continue;
      }
      const deployAgentDefinitionInput = {
        tenantId: input.tenantId,
        principalId: input.principalId,
        name: step.create.name,
        handle: step.handle,
        systemPrompt: step.create.systemPrompt,
        toolPackagePins: step.create.toolPackagePins,
        skills: step.create.skills,
        credentialBindings: step.credentialBindings,
      };
      const deployed = await deps.deployAgentDefinition(
        step.create.modelPreference !== undefined
          ? {
              ...deployAgentDefinitionInput,
              model: step.create.modelPreference,
            }
          : deployAgentDefinitionInput,
      );
      deployedDefinitionIds.push(deployed.definitionId);
      const leg = { definitionId: deployed.definitionId, prompt: step.prompt };
      legs.push(
        step.create.modelPreference !== undefined
          ? { ...leg, modelPreference: step.create.modelPreference }
          : leg,
      );
    }
    return legs;
  } catch (err) {
    await Promise.all(
      deployedDefinitionIds.map((definitionId) =>
        deps.undeployAgentDefinition({
          tenantId: input.tenantId,
          definitionId,
        }),
      ),
    );
    throw err;
  }
}

/** Spawns a `{kind: "chain"}` spec as ONE task with N pending legs —
 * `@corbits/tasks`' own leg contract (`launchTask`'s `followOn`), never
 * reimplemented here. Every step's definition is resolved and, for a
 * `{create}` step, deployed up front, all-or-nothing; only then does
 * leg 1 launch through the exact same `launchTask` path a single-task
 * spec uses, with steps 2..N riding along as `followOn` — pending legs
 * `advanceChain` (`@corbits/tasks`' `chain.ts`) hands the work to, one
 * at a time, as each prior leg settles. */
async function spawnChainFromTaskSpec(
  deps: SpawnDeps,
  input: SpawnFromTaskSpecInput,
  spec: Extract<TaskSpec, { kind: "chain" }>,
): Promise<TaskRecord> {
  const resolved = resolveChainSteps(spec.steps, input.inventory);

  // One grant check for the whole chain, before any step deploys —
  // never one check per `{create}` step.
  if (resolved.some((step) => step.kind === "create")) {
    await deps.requireDefinitionCreateGrant({
      tenantId: input.tenantId,
      principalId: input.principalId,
    });
  }

  const legs = await deployChainSteps(deps, input, resolved);
  const [first, ...followOn] = legs;
  if (first === undefined) {
    // Unreachable: `TaskSpec`'s own arktype bound guarantees at least
    // two steps in `spec.steps` — this is TypeScript's narrowing
    // satisfied honestly, not a real branch.
    throw new Error("a chain spec produced zero legs");
  }

  const launchTaskInput = {
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId: first.definitionId,
    prompt: first.prompt,
    followOn: followOn.map((leg): TaskLegSpec => ({
      definitionId: leg.definitionId,
      prompt: leg.prompt,
      modelPreference: leg.modelPreference ?? null,
    })),
  };
  const record = await launchTask(
    deps.taskLauncherDeps,
    first.modelPreference !== undefined
      ? { ...launchTaskInput, modelPreference: first.modelPreference }
      : launchTaskInput,
  );

  await deps.store.linkPlannerRun({
    tenantId: input.tenantId,
    id: record.id,
    plannerRunId: input.plannerRunId,
  });

  return { ...record, plannerRunId: input.plannerRunId };
}

async function spawnSingleTaskFromTaskSpec(
  deps: SpawnDeps,
  input: SpawnFromTaskSpecInput,
  spec: Exclude<TaskSpec, { kind: "chain" }>,
): Promise<TaskRecord> {
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
          const deployAgentDefinitionInput = {
            tenantId: input.tenantId,
            principalId: input.principalId,
            name: create.name,
            handle,
            systemPrompt: create.systemPrompt,
            toolPackagePins: create.toolPackagePins,
            skills: create.skills,
            credentialBindings,
          };
          const deployed = await deps.deployAgentDefinition(
            create.modelPreference !== undefined
              ? { ...deployAgentDefinitionInput, model: create.modelPreference }
              : deployAgentDefinitionInput,
          );
          return deployed.definitionId;
        })();

  const launchTaskInput = {
    tenantId: input.tenantId,
    principalId: input.principalId,
    definitionId,
    prompt: spec.refinedOutcome,
  };
  const record = await launchTask(
    deps.taskLauncherDeps,
    "create" in spec && spec.create.modelPreference !== undefined
      ? { ...launchTaskInput, modelPreference: spec.create.modelPreference }
      : launchTaskInput,
  );

  await deps.store.linkPlannerRun({
    tenantId: input.tenantId,
    id: record.id,
    plannerRunId: input.plannerRunId,
  });

  return { ...record, plannerRunId: input.plannerRunId };
}

export async function spawnFromTaskSpec(
  deps: SpawnDeps,
  input: SpawnFromTaskSpecInput,
): Promise<TaskRecord> {
  if (input.spec.kind === "chain") {
    return spawnChainFromTaskSpec(deps, input, input.spec);
  }
  return spawnSingleTaskFromTaskSpec(deps, input, input.spec);
}
