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
import {
  withAvailableSkills,
  type PinnedSkillIndexEntry,
} from "@corbits/skills";
import { type } from "arktype";

export const AGENT_DEFINITION_STEP_ID = "agent";

/**
 * Where a hand-authored agent's attached skills live inside its
 * `workflow`-kind asset — a sibling of `workflow.json`, written in the
 * same commit, rather than a field on `WorkflowDefinition` itself.
 *
 * `AgentDefinition`'s own `skills`-shaped field and its launch-time
 * consumption belong to `@intx/agent`/`@intx/hub-sessions` (see
 * `toolPackagePins`'s precedent there); until that lands, this asset-tree
 * sidecar is the durable, round-trippable record of what a definition
 * carries, kept alongside the definition body it describes.
 */
export const AGENT_SKILLS_ASSET_PATH = "skills.json";

const SkillsFile = type({ skills: "string[]" });

/**
 * The part of a serialized definition the pinned-skills index rewrites:
 * every step's agent system prompt. Undeclared keys pass through, so
 * re-serializing a validated definition preserves the trigger, the step
 * timeouts, the inference sources, and everything else the builder put
 * there.
 */
const DefinitionWithAgentSteps = type({
  steps: {
    "[string]": type({
      agent: type({ systemPrompt: "string" }).onUndeclaredKey("ignore"),
    }).onUndeclaredKey("ignore"),
  },
}).onUndeclaredKey("ignore");

/**
 * Rewrites every step agent's system prompt so it carries an
 * `<available_skills>` index for exactly `entries` — replacing whatever
 * index a previous push left, so re-pinning is idempotent and unpinning
 * removes the stanza outright.
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
  }
  return JSON.stringify(definition);
}

/** Serializes an agent definition's attached skill names to the JSON
 * `AGENT_SKILLS_ASSET_PATH` carries in the asset tree. */
export function serializeAgentSkills(skills: readonly string[]): string {
  return JSON.stringify({ skills });
}

/** Parses `AGENT_SKILLS_ASSET_PATH`'s bytes back into a skill name list.
 * Fails closed on malformed content — a corrupt or hand-edited file
 * should surface as an error, not silently launch an agent with fewer
 * skills than it was given. Callers that treat "no such file" (a
 * definition created before this feature existed) as "no skills" decide
 * that at the asset-read call site, not here. */
export function parseAgentSkills(bytes: Uint8Array): readonly string[] {
  const text = new TextDecoder().decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const result = SkillsFile(parsed);
  if (result instanceof type.errors) {
    throw new Error(
      `${AGENT_SKILLS_ASSET_PATH} is malformed: ${result.summary}`,
    );
  }
  return result.skills;
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
  return defineWorkflow({
    id: `wf_agent_${input.handle}`,
    trigger: { type: "mail", to: `${input.handle}@${input.tenantDomain}` },
    steps: {
      [AGENT_DEFINITION_STEP_ID]: step({
        agent: defineAgent({
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
        }),
        timeout: AGENT_DEFINITION_TURN_TIMEOUT_MS,
      }),
    },
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
