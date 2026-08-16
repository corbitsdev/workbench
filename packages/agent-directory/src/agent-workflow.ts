// Builds the single-step, folded workflow definition a hand-authored
// agent materializes as: exactly the shape `@corbits/chat`'s own
// `buildChannelHostWorkflow`/`@corbits/assistant-workflow`'s
// `buildAssistantWorkflow` produce, but with the system prompt and
// model left to the caller instead of fixed at build time — this is
// the one difference that makes a defined-by-a-person agent possible
// alongside the platform's own fixed starter agents.
//
// This package is installable data, exactly like `@corbits/chat`'s
// channel-host builder: nothing imports it statically, and a host
// publishes the serialized definition as a workflow asset before
// deploying or launching it.

import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type { CredentialBinding } from "@intx/types";
import {
  withAvailableSkills,
  type PinnedSkillIndexEntry,
} from "@corbits/skills";
import { type } from "arktype";

export const AGENT_DEFINITION_STEP_ID = "agent";

/**
 * The tool package that turns a name in the `<available_skills>` index
 * into an actual skill body at run time. A definition that pins skills
 * must pin this too, or its prompt would tell the model to call a
 * `load_skill` tool that does not exist.
 */
export const SKILLS_TOOL_PACKAGE_PIN = {
  name: "@corbits/tools-skills",
  version: "0.0.1",
} as const;

/**
 * The parts of a serialized definition the pinned-skills reindex
 * rewrites: every step agent's system prompt and its tool-package pins.
 * Undeclared keys pass through, so re-serializing a validated definition
 * preserves the trigger, the step timeouts, the inference sources, and
 * everything else the builder put there.
 */
const DefinitionWithAgentSteps = type({
  steps: {
    "[string]": type({
      agent: type({
        systemPrompt: "string",
        "toolPackagePins?": type({
          name: "string",
          version: "string",
        })
          .onUndeclaredKey("ignore")
          .array(),
        "inference?": type({
          sources: type({
            provider: "string",
            "model?": "string",
          })
            .onUndeclaredKey("ignore")
            .array(),
        }).onUndeclaredKey("ignore"),
      }).onUndeclaredKey("ignore"),
    }).onUndeclaredKey("ignore"),
  },
}).onUndeclaredKey("ignore");

type AgentToolPackagePins = NonNullable<
  (typeof DefinitionWithAgentSteps.infer.steps)[string]["agent"]["toolPackagePins"]
>;

/** The pins a step agent should carry for exactly `entries`: the skills
 * bundle present iff something is pinned, every other pin untouched. */
function withSkillsToolPin(
  existing: AgentToolPackagePins,
  pinsSkills: boolean,
): AgentToolPackagePins {
  const others = existing.filter(
    (pin) => pin.name !== SKILLS_TOOL_PACKAGE_PIN.name,
  );
  return pinsSkills ? [...others, { ...SKILLS_TOOL_PACKAGE_PIN }] : others;
}

/**
 * Rewrites every step agent so it advertises exactly `entries`: an
 * `<available_skills>` index in the system prompt, and the skills tool
 * bundle among its tool-package pins. Replaces whatever a previous push
 * left, so re-pinning is idempotent and unpinning removes both.
 */
export function reindexPinnedSkills(
  workflowJson: string,
  entries: readonly PinnedSkillIndexEntry[],
): string {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry step agents to index skills into: ${definition.summary}`,
    );
  }
  for (const step of Object.values(definition.steps)) {
    step.agent.systemPrompt = withAvailableSkills(
      step.agent.systemPrompt,
      entries,
    );
    step.agent.toolPackagePins = withSkillsToolPin(
      step.agent.toolPackagePins ?? [],
      entries.length > 0,
    );
  }
  return JSON.stringify(definition);
}

/** Reads a definition's system prompt back out of its serialized
 * `workflow.json` — the raw text a person edits in the Assistant
 * settings section, before `reindexPinnedSkills` appends the
 * `<available_skills>` index on top of it at save time. Every builder
 * in this codebase produces exactly one step, so the definition's one
 * step is unambiguous regardless of the step's own key. */
export function readAgentSystemPrompt(workflowJson: string): string {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to read a system prompt from: ${definition.summary}`,
    );
  }
  const [step] = Object.values(definition.steps);
  if (step === undefined) {
    throw new Error("workflow.json has no steps");
  }
  return step.agent.systemPrompt;
}

/** Replaces a definition's system prompt in its serialized
 * `workflow.json`, leaving every other field — the trigger, timeouts,
 * inference sources, tool-package pins — untouched. */
export function withAgentSystemPrompt(
  workflowJson: string,
  systemPrompt: string,
): string {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to write a system prompt into: ${definition.summary}`,
    );
  }
  const [step] = Object.values(definition.steps);
  if (step === undefined) {
    throw new Error("workflow.json has no steps");
  }
  step.agent.systemPrompt = systemPrompt;
  return JSON.stringify(definition);
}

/** A definition's guided-capability-add surface: the tool packages it
 * pins directly (beyond whatever `reindexPinnedSkills` pins for
 * skills — see `SKILLS_TOOL_PACKAGE_PIN`) and the model it resolves
 * against, read back out of its serialized `workflow.json`. */
export type AgentDefinitionCapabilities = {
  readonly toolPackagePins: readonly ToolPackagePin[];
  readonly model?: string;
};

/** Reads a definition's current guided-capability state out of its
 * serialized `workflow.json` — the same fields `withAgentToolPackagePin`/
 * `withAgentModel` write, read back for the settings surface's
 * "Capabilities" list and for merging an additive pin. */
export function readAgentCapabilities(
  workflowJson: string,
): AgentDefinitionCapabilities {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to read capabilities from: ${definition.summary}`,
    );
  }
  const [step] = Object.values(definition.steps);
  if (step === undefined) {
    throw new Error("workflow.json has no steps");
  }
  const model = step.agent.inference?.sources[0]?.model;
  return model !== undefined
    ? { toolPackagePins: step.agent.toolPackagePins ?? [], model }
    : { toolPackagePins: step.agent.toolPackagePins ?? [] };
}

/** Adds or replaces one tool-package pin by name, leaving every other
 * pin — including the skills bundle `reindexPinnedSkills` manages —
 * untouched. Mirrors `withSkillsToolPin`'s replace-by-name shape,
 * generalized to a caller-supplied pin rather than the fixed skills
 * bundle. */
export function withAgentToolPackagePin(
  workflowJson: string,
  pin: ToolPackagePin,
): string {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to pin a tool package into: ${definition.summary}`,
    );
  }
  for (const step of Object.values(definition.steps)) {
    const others = (step.agent.toolPackagePins ?? []).filter(
      (existing) => existing.name !== pin.name,
    );
    step.agent.toolPackagePins = [...others, { ...pin }];
  }
  return JSON.stringify(definition);
}

/** Sets a definition's model preference, leaving every other inference
 * field (and every other step field) untouched. Mirrors the placeholder
 * `buildAgentDefinitionWorkflow` sets at create time (`provider:
 * "catalog"` — resolved fresh at launch, never baked in). */
export function withAgentModel(workflowJson: string, model: string): string {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to set a model on: ${definition.summary}`,
    );
  }
  for (const step of Object.values(definition.steps)) {
    step.agent.inference = { sources: [{ provider: "catalog", model }] };
  }
  return JSON.stringify(definition);
}

/** Everything a hand-authored agent definition needs baked in at
 * creation time. */
export interface AgentDefinitionWorkflowInput {
  /** The definition's mail handle; only used to give the definition's
   * placeholder trigger a readable address — an invited launch mints
   * its own per-instance address and never reads this one. */
  readonly handle: string;
  readonly tenantDomain: string;
  readonly description: string;
  readonly systemPrompt: string;
  /** A canonical model name from the tenant's catalog, or omitted to
   * resolve against whatever catalog default the tenant has seeded.
   * Never a provider — provider resolution happens at launch time
   * against the live catalog (see `resolveDefinitionSources`), not
   * baked into the definition. */
  readonly model?: string;
  /**
   * Tool packages pinned directly on this definition — connector tool
   * bundles (e.g. `@corbits/granola-tools`) a planner-created agent
   * needs beyond what skills reindexing pins. Additive: undeclared or
   * empty behaves exactly like a definition built before this field
   * existed. `defineAgent`'s own `DefineAgentConfig` has no field for
   * this (only `AgentDefinition` itself carries `toolPackagePins`, as
   * a passthrough for the sidecar's tool-materialization step — see
   * `@intx/agent`'s `definition.ts`), so it is set directly on the
   * definition `defineAgent` returns rather than threaded through the
   * config, mirroring how `reindexPinnedSkills` sets the same field
   * post-hoc for skills.
   */
  readonly toolPackagePins?: readonly ToolPackagePin[];
  /**
   * Credential bindings the deployed definition carries at the workflow
   * level — the same `CredentialBinding[]` shape and the same
   * `defineWorkflow({ credentialBindings, ... })` field
   * `workflows/granola-call` pins through (CL-6028's pattern). Additive:
   * undeclared or empty behaves exactly like a definition built before
   * this field existed. Required for a `toolPackagePins` entry whose
   * tool needs a live credential to do anything at runtime — a pin with
   * no matching binding is inert.
   */
  readonly credentialBindings?: readonly CredentialBinding[];
}

/**
 * Builds the definition. Exactly one step, on purpose — the same
 * contract every other folded builder in this codebase holds to: a
 * second step would trade away the conversational, warm-agent memory
 * a folded launch depends on.
 */
export function buildAgentDefinitionWorkflow(
  input: AgentDefinitionWorkflowInput,
): WorkflowDefinition {
  if (input.handle === "") {
    throw new Error("buildAgentDefinitionWorkflow requires a non-empty handle");
  }
  if (input.systemPrompt === "") {
    throw new Error(
      "buildAgentDefinitionWorkflow requires a non-empty systemPrompt",
    );
  }
  const agent = defineAgent({
    id: AGENT_DEFINITION_STEP_ID,
    description: input.description,
    systemPrompt: input.systemPrompt,
    tools: [],
    capabilities: [],
    inference: {
      // `provider` only participates in deploy-hash bookkeeping —
      // launch-time resolution reads `model` alone and resolves a
      // provider fresh against the tenant catalog (see
      // `resolveDefinitionSources`), so a placeholder here costs
      // nothing real.
      sources:
        input.model !== undefined
          ? [{ provider: "catalog", model: input.model }]
          : [],
    },
  });
  const trigger = {
    type: "mail" as const,
    to: `${input.handle}@${input.tenantDomain}`,
  };
  const steps = {
    [AGENT_DEFINITION_STEP_ID]: step({
      agent:
        input.toolPackagePins !== undefined
          ? { ...agent, toolPackagePins: input.toolPackagePins }
          : agent,
      timeout: AGENT_DEFINITION_TURN_TIMEOUT_MS,
    }),
  };
  return input.credentialBindings !== undefined &&
    input.credentialBindings.length > 0
    ? defineWorkflow({
        id: `wf_agent_${input.handle}`,
        trigger,
        credentialBindings: input.credentialBindings,
        steps,
      })
    : defineWorkflow({
        id: `wf_agent_${input.handle}`,
        trigger,
        steps,
      });
}

const AGENT_DEFINITION_TURN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Serializes a definition to the JSON a workflow asset carries.
 * Re-implemented rather than shared: `assertJsonPortable` is
 * module-private in every builder package that carries a copy of it,
 * by design (see `@corbits/chat`'s `channel-workflow.ts`), so this
 * copy stays consistent with that convention rather than reaching
 * into another package's internals.
 */
export function serializeAgentDefinitionWorkflow(
  definition: WorkflowDefinition,
): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

function assertJsonPortable(value: unknown, path: string): void {
  if (value === null) return;
  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`${path} is a non-finite number; JSON drops it`);
      }
      return;
    case "object":
      break;
    default:
      throw new Error(
        `${path} is a ${typeof value}, which does not survive JSON serialization`,
      );
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `${path} is a non-plain object; JSON would flatten it lossily`,
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}
