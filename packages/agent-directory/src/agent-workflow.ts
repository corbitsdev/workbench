// Builds the single-step, folded workflow definition a hand-authored agent
// materializes as, with system prompt and model left to the caller.

import { defineAgent } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";
import type { CredentialBinding } from "@intx/types";
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { asset, workflowDefinition } from "@intx/db/schema";
import { AssetServiceError } from "@intx/hub-sessions";
import type { AssetService } from "@intx/hub-sessions";
import {
  AVAILABLE_SKILLS_CLOSE_TAG,
  AVAILABLE_SKILLS_OPEN_TAG,
  withAvailableSkills,
  type PinnedSkillIndexEntry,
} from "@corbits/skills-tools";
import { type } from "arktype";
import semver from "semver";

import { writeAndDeployAgentDefinition, type AgentDefinitionDeployer } from "./definition-asset";
import { createPinnedVersionResolver } from "./tool-package-version";

export const AGENT_DEFINITION_STEP_ID = "agent";

/** Turns a name in the `<available_skills>` index into an actual skill body
 * at run time. A definition that pins skills must pin this too. */
export const SKILLS_TOOL_PACKAGE_PIN = {
  name: "@corbits/skills-tools",
  version: "0.0.9",
} as const;

/** The parts of a serialized definition the pinned-skills reindex rewrites.
 * Undeclared keys pass through, so re-serializing preserves everything else
 * the builder put there. */
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
  const others = existing.filter((pin) => pin.name !== SKILLS_TOOL_PACKAGE_PIN.name);
  return pinsSkills ? [...others, { ...SKILLS_TOOL_PACKAGE_PIN }] : others;
}

/** Rewrites every step agent to advertise exactly `entries`. Replaces
 * whatever a previous push left, so re-pinning is idempotent. */
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
    step.agent.systemPrompt = withAvailableSkills(step.agent.systemPrompt, entries);
    step.agent.toolPackagePins = withSkillsToolPin(
      step.agent.toolPackagePins ?? [],
      entries.length > 0,
    );
  }
  return JSON.stringify(definition);
}

/** Reads pinned skill names back out of the `<available_skills>` stanza
 * `reindexPinnedSkills` writes. The asset is the source of truth — every
 * pin writer reindexes in the same commit it deploys. */
export function readPinnedSkillNames(workflowJson: string): readonly string[] {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry step agents to read pinned skills from: ${definition.summary}`,
    );
  }
  const [step] = Object.values(definition.steps);
  if (step === undefined) {
    throw new Error("workflow.json has no steps");
  }
  const open = step.agent.systemPrompt.indexOf(AVAILABLE_SKILLS_OPEN_TAG);
  const close = step.agent.systemPrompt.indexOf(AVAILABLE_SKILLS_CLOSE_TAG);
  if (open === -1 || close === -1 || close < open) return [];
  // Stanza lines render as `- name: description`, and skill names can
  // never contain a space or a colon, so the first colon on a `- ` line
  // always ends the name — even when the description itself holds colons.
  const body = step.agent.systemPrompt.slice(open + AVAILABLE_SKILLS_OPEN_TAG.length, close);
  const names: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) continue;
    const colon = trimmed.indexOf(":", 2);
    if (colon === -1) continue;
    const name = trimmed.slice(2, colon).trim();
    if (name !== "") names.push(name);
  }
  return names;
}

/** Reads the raw system prompt a person edits, before `reindexPinnedSkills`
 * appends the `<available_skills>` index at save time. */
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
export function withAgentSystemPrompt(workflowJson: string, systemPrompt: string): string {
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

/** A definition's guided-capability-add surface: its directly pinned tool
 * packages and the model it resolves against. */
export type AgentDefinitionCapabilities = {
  readonly toolPackagePins: readonly ToolPackagePin[];
  readonly model?: string;
};

/** Reads the same fields `withAgentToolPackagePin`/`withAgentModel` write,
 * for the settings surface's "Capabilities" list. */
export function readAgentCapabilities(workflowJson: string): AgentDefinitionCapabilities {
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

/** A tool-package pin resolved to a concrete, published version — never
 * `*`. Every runtime pin site must name a version the resolver actually
 * offers, or a later tarball would silently change what runs. */
export const NonWildcardToolPackagePin = type({
  name: "string",
  version: "string",
}).narrow((pin, ctx) =>
  semver.valid(pin.version) !== null
    ? true
    : ctx.mustBe(
        'a concrete published version, never "*", "latest", or a range/tag like "^1", "~1.2", ">=1.0.0", "1.x" — anything but an exact version would let a later tarball silently change what this pin resolves to',
      ),
);
export type NonWildcardToolPackagePin = typeof NonWildcardToolPackagePin.infer;

/** Adds or replaces one tool-package pin by name, leaving every other pin
 * untouched. Rejects a `"*"` version outright. */
export function withAgentToolPackagePin(
  workflowJson: string,
  pin: NonWildcardToolPackagePin,
): string {
  const parsedPin = NonWildcardToolPackagePin(pin);
  if (parsedPin instanceof type.errors) {
    throw new Error(`withAgentToolPackagePin: pin must be ${parsedPin.summary}`);
  }
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to pin a tool package into: ${definition.summary}`,
    );
  }
  for (const step of Object.values(definition.steps)) {
    const others = (step.agent.toolPackagePins ?? []).filter(
      (existing) => existing.name !== parsedPin.name,
    );
    step.agent.toolPackagePins = [...others, { ...parsedPin }];
  }
  return JSON.stringify(definition);
}

/** Sets a definition's model preference, leaving every other field
 * untouched. `provider: "catalog"` resolves fresh at launch, never baked in. */
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

/** Clears a definition's model preference; launch-time resolution then
 * falls to the tenant's catalog default. The inverse of `withAgentModel`. */
export function withoutAgentModel(workflowJson: string): string {
  const raw: unknown = JSON.parse(workflowJson);
  const definition = DefinitionWithAgentSteps(raw);
  if (definition instanceof type.errors) {
    throw new Error(
      `workflow.json does not carry a step agent to clear a model on: ${definition.summary}`,
    );
  }
  for (const step of Object.values(definition.steps)) {
    step.agent.inference = { sources: [] };
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
  /** Tool packages pinned directly beyond what skills reindexing pins.
   * Additive: undeclared or empty behaves as before this field existed. */
  readonly toolPackagePins?: readonly ToolPackagePin[];
  /** Credential bindings at the workflow level. Required for a
   * `toolPackagePins` entry whose tool needs a live credential — a pin
   * with no matching binding is inert. */
  readonly credentialBindings?: readonly CredentialBinding[];
}

/** Builds the definition. Exactly one step, on purpose — a second step
 * would trade away the conversational, warm-agent memory a folded launch
 * depends on. */
export function buildAgentDefinitionWorkflow(
  input: AgentDefinitionWorkflowInput,
): WorkflowDefinition {
  if (input.handle === "") {
    throw new Error("buildAgentDefinitionWorkflow requires a non-empty handle");
  }
  if (input.systemPrompt === "") {
    throw new Error("buildAgentDefinitionWorkflow requires a non-empty systemPrompt");
  }
  const agent = defineAgent({
    id: AGENT_DEFINITION_STEP_ID,
    description: input.description,
    systemPrompt: input.systemPrompt,
    tools: [],
    capabilities: [],
    inference: {
      // `provider` only participates in deploy-hash bookkeeping;
      // launch-time resolution reads `model` alone.
      sources: input.model !== undefined ? [{ provider: "catalog", model: input.model }] : [],
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
      triggers: "unbounded",
    }),
  };
  return input.credentialBindings !== undefined && input.credentialBindings.length > 0
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

/** Serializes a definition to the JSON a workflow asset carries. Its own
 * `assertJsonPortable`, not shared, since that helper is module-private by
 * convention in every builder package that carries a copy. */
export function serializeAgentDefinitionWorkflow(definition: WorkflowDefinition): string {
  assertJsonPortable(definition, "definition");
  return JSON.stringify(definition);
}

export type CreateAgentDefinitionCoreDeps = {
  readonly db: DB["db"];
  readonly assetService: AssetService;
  /** Deploys the definition's commit through the native source pipeline
   * (install -> sidecar probe -> gate -> freeze) at create. */
  readonly deployer: AgentDefinitionDeployer;
  readonly skillIndex: {
    resolve(
      tenantId: string,
      principalId: string,
      names: readonly string[],
    ): Promise<readonly PinnedSkillIndexEntry[]>;
  };
  /** Resolves the tenant's catalog default model for a create call that
   * supplies none. Without this, the definition's `inference.sources`
   * stays empty and a later invite launch 409s as `not_launchable`. */
  readonly tenantDefaultModel?: (tenantId: string) => Promise<string | undefined>;
};

export type CreateAgentDefinitionCoreInput = {
  readonly tenantId: string;
  readonly principalId: string;
  /** The tenant's mail domain the placeholder mail trigger addresses
   * under. Supplied by the caller to avoid a redundant lookup here. */
  readonly tenantDomain: string;
  readonly handle: string;
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly model?: string;
  readonly skills: readonly string[];
  /** Tool packages pinned directly by name, applied once per name after
   * the skills reindex. */
  readonly toolPackagePins?: readonly string[];
};

export type CreateAgentDefinitionCoreResult = {
  readonly row: typeof workflowDefinition.$inferSelect;
};

/** Thrown when `input.handle` already names a definition in this tenant,
 * so each HTTP caller can translate it into its own response shape. */
export class DuplicateAgentHandleError extends Error {
  constructor(handle: string) {
    super(`An agent with the handle "${handle}" already exists`);
    this.name = "DuplicateAgentHandleError";
  }
}

/** The full create-agent-definition sequence: build and pin the definition,
 * materialize it as a `workflow`-kind asset, and project it onto a
 * `workflow_definition` row. Factored out so every caller uses the exact
 * same materialization, never a second, drifting implementation. */
export async function createAgentDefinitionCore(
  deps: CreateAgentDefinitionCoreDeps,
  input: CreateAgentDefinitionCoreInput,
): Promise<CreateAgentDefinitionCoreResult> {
  const baseDefinitionInput = {
    handle: input.handle,
    tenantDomain: input.tenantDomain,
    description: input.description ?? "",
    systemPrompt: input.systemPrompt,
  };
  const model = input.model ?? (await deps.tenantDefaultModel?.(input.tenantId));
  const definition = buildAgentDefinitionWorkflow(
    model !== undefined ? { ...baseDefinitionInput, model } : baseDefinitionInput,
  );
  let workflowJson = reindexPinnedSkills(
    serializeAgentDefinitionWorkflow(definition),
    await deps.skillIndex.resolve(input.tenantId, input.principalId, input.skills),
  );
  // One resolver shared across every named pin, so a five-pin create
  // still costs one ancestor walk and one listing, not five.
  const resolvePin = createPinnedVersionResolver(
    { db: deps.db, assetService: deps.assetService },
    input.tenantId,
  );
  for (const name of input.toolPackagePins ?? []) {
    const resolvedPin = await resolvePin(name);
    workflowJson = withAgentToolPackagePin(workflowJson, resolvedPin);
  }

  let assetId: string;
  try {
    const created = await deps.assetService.createAsset({
      tenantId: input.tenantId,
      kind: "workflow",
      name: input.handle,
      displayName: input.name,
      creatorPrincipalId: input.principalId,
    });
    assetId = created.id;
  } catch (cause) {
    if (cause instanceof AssetServiceError && cause.reason === "duplicate_asset") {
      // Recover from a prior attempt's empty-shell asset: reuse it only
      // if it has no definition yet.
      const existing = await deps.db.query.asset.findFirst({
        where: and(
          eq(asset.tenantId, input.tenantId),
          eq(asset.kind, "workflow"),
          eq(asset.name, input.handle),
        ),
      });
      if (existing === undefined) {
        throw new DuplicateAgentHandleError(input.handle);
      }
      const hasDefinition = await deps.db.query.workflowDefinition.findFirst({
        where: and(
          eq(workflowDefinition.assetId, existing.id),
          eq(workflowDefinition.tenantId, input.tenantId),
        ),
      });
      if (hasDefinition !== undefined) {
        throw new DuplicateAgentHandleError(input.handle);
      }
      assetId = existing.id;
    } else {
      throw cause;
    }
  }

  await writeAndDeployAgentDefinition({
    assetService: deps.assetService,
    deployer: deps.deployer,
    tenantId: input.tenantId,
    principalId: input.principalId,
    assetId,
    handle: input.handle,
    workflowJson,
    message: `Define agent ${input.name}`,
  });

  // The deploy above projects, walks, and stamps the definition row in
  // one transaction — the same machinery the sidecar probe deploy
  // rides. Read the row back by asset, newest first: a content-unchanged
  // redeploy dedupes onto the existing `(assetId, wireHash)` row, so
  // this still resolves to the one row a fresh create just produced.
  const row = await deps.db.query.workflowDefinition.findFirst({
    where: and(
      eq(workflowDefinition.assetId, assetId),
      eq(workflowDefinition.tenantId, input.tenantId),
    ),
    orderBy: desc(workflowDefinition.createdAt),
  });
  if (row === undefined) {
    throw new Error(`agent definition for asset "${assetId}" was created but is not readable back`);
  }
  return { row };
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
      throw new Error(`${path} is a ${typeof value}, which does not survive JSON serialization`);
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => {
      assertJsonPortable(element, `${path}[${index}]`);
    });
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(`${path} is a non-plain object; JSON would flatten it lossily`);
  }
  for (const [key, entry] of Object.entries(value)) {
    assertJsonPortable(entry, `${path}.${key}`);
  }
}
