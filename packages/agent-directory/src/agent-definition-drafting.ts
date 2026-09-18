// Myra-backed agent-definition drafting: turns a name and a plain-language
// description into a machine-checked draft via one one-shot Myra call.
// Every failure mode propagates as its own specific error; nothing here
// fabricates a draft or falls back to a template. This module only
// proposes — the caller submits the validated draft through the
// sanctioned REST create path, exactly like a hand-authored agent.

import { type } from "arktype";

import type { OneShotReply } from "./one-shot-prompt";

import { BoundedDedupedToolPackageNameArray } from "./create-bounds";
import { assembleInventory, type InventorySources, type PlannerInventory } from "./inventory";

const DEFAULT_DRAFTING_TIMEOUT_MS = 60_000;
const MAX_REPLY_EXCERPT = 400;
const MAX_SYSTEM_PROMPT_LENGTH = 8000;
const MAX_DESCRIPTION_LENGTH = 500;

/** The `request_capability` bundle every drafted agent gets pinned by
 * default, so self-service capability requests aren't something Myra has
 * to remember to choose. Only added when the tenant's inventory offers it. */
const CAPABILITY_REQUEST_TOOL_PACKAGE = "@corbits/capability-tools";

/** Adds `CAPABILITY_REQUEST_TOOL_PACKAGE` when the inventory offers it and
 * it isn't already there. Applied to every draft unconditionally. */
function withDefaultCapabilityRequestPin(
  toolPackagePins: readonly string[],
  inventory: PlannerInventory,
): readonly string[] {
  const offered = inventory.toolPackages.some(
    (entry) => entry.name === CAPABILITY_REQUEST_TOOL_PACKAGE,
  );
  if (!offered || toolPackagePins.includes(CAPABILITY_REQUEST_TOOL_PACKAGE)) {
    return toolPackagePins;
  }
  return [...toolPackagePins, CAPABILITY_REQUEST_TOOL_PACKAGE];
}

// --- reply contract ---

const BoundedSystemPrompt = type("string > 0").narrow((value, ctx) =>
  value.length <= MAX_SYSTEM_PROMPT_LENGTH
    ? true
    : ctx.mustBe(`at most ${MAX_SYSTEM_PROMPT_LENGTH} characters`),
);

const BoundedDescription = type("string > 0").narrow((value, ctx) =>
  value.length <= MAX_DESCRIPTION_LENGTH
    ? true
    : ctx.mustBe(`at most ${MAX_DESCRIPTION_LENGTH} characters`),
);

/** Myra's reply shape. Nothing here is deployed until
 * `validateAgentDefinitionDraftReplyAgainstInventory` proves every
 * reference was actually offered. */
export const AgentDefinitionDraftReply = type({
  systemPrompt: BoundedSystemPrompt,
  "description?": BoundedDescription,
  "modelPreference?": "string > 0",
  "toolPackagePins?": "string[]",
  "skills?": "string[]",
});
export type AgentDefinitionDraftReply = typeof AgentDefinitionDraftReply.infer;

/** The validated, deploy-ready shape `propose` resolves with. */
export type AgentDefinitionDraft = {
  readonly systemPrompt: string;
  readonly description?: string;
  readonly modelPreference?: string;
  readonly toolPackagePins: readonly string[];
  readonly skills: readonly string[];
};

function excerpt(raw: string): string {
  return raw.length > MAX_REPLY_EXCERPT ? `${raw.slice(0, MAX_REPLY_EXCERPT)}…` : raw;
}

export class AgentDefinitionDraftReplyUnparseableError extends Error {
  constructor(reason: string, raw: string) {
    super(
      `Myra's reply couldn't be read as an agent draft: ${reason} ` +
        `(reply excerpt: ${excerpt(raw)})`,
    );
    this.name = "AgentDefinitionDraftReplyUnparseableError";
  }
}

export class AgentDefinitionDraftReferenceOutOfInventoryError extends Error {
  constructor(field: string, reference: string) {
    super(
      `Myra's draft named "${reference}" for "${field}", which was never ` +
        "offered in the inventory",
    );
    this.name = "AgentDefinitionDraftReferenceOutOfInventoryError";
  }
}

export class MyraAgentDefinitionDraftingUnavailableError extends Error {
  constructor(tenantId: string, reason: string) {
    super(`Myra isn't available for tenant "${tenantId}": ${reason}`);
    this.name = "MyraAgentDefinitionDraftingUnavailableError";
  }
}

/** Parses `raw` as an `AgentDefinitionDraftReply`, throwing on malformed
 * JSON, a bad shape, or an over-cardinality/duplicate pins array. */
export function parseAgentDefinitionDraftReply(raw: string): AgentDefinitionDraftReply {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentDefinitionDraftReplyUnparseableError("not valid JSON", raw);
  }
  const parsed = AgentDefinitionDraftReply(json);
  if (parsed instanceof type.errors) {
    throw new AgentDefinitionDraftReplyUnparseableError(parsed.summary, raw);
  }
  if (parsed.toolPackagePins !== undefined) {
    const bounded = BoundedDedupedToolPackageNameArray(parsed.toolPackagePins);
    if (bounded instanceof type.errors) {
      throw new AgentDefinitionDraftReplyUnparseableError(bounded.summary, raw);
    }
  }
  return parsed;
}

/** Asserts every reference the reply makes actually appears in the
 * inventory offered to Myra, then returns the deploy-ready draft. */
export function validateAgentDefinitionDraftReplyAgainstInventory(
  reply: AgentDefinitionDraftReply,
  inventory: PlannerInventory,
): AgentDefinitionDraft {
  if (reply.modelPreference !== undefined) {
    const known = inventory.models.some((model) => model.canonicalName === reply.modelPreference);
    if (!known) {
      throw new AgentDefinitionDraftReferenceOutOfInventoryError(
        "modelPreference",
        reply.modelPreference,
      );
    }
  }

  const toolPackageNames = new Set(inventory.toolPackages.map((entry) => entry.name));
  for (const pin of reply.toolPackagePins ?? []) {
    if (!toolPackageNames.has(pin)) {
      throw new AgentDefinitionDraftReferenceOutOfInventoryError("toolPackagePins", pin);
    }
  }

  const skillNames = new Set(inventory.skills.map((skill) => skill.name));
  for (const skill of reply.skills ?? []) {
    if (!skillNames.has(skill)) {
      throw new AgentDefinitionDraftReferenceOutOfInventoryError("skills", skill);
    }
  }

  const base: AgentDefinitionDraft = {
    systemPrompt: reply.systemPrompt,
    toolPackagePins: withDefaultCapabilityRequestPin(reply.toolPackagePins ?? [], inventory),
    skills: reply.skills ?? [],
  };
  const withDescription =
    reply.description !== undefined ? { ...base, description: reply.description } : base;
  return reply.modelPreference !== undefined
    ? { ...withDescription, modelPreference: reply.modelPreference }
    : withDescription;
}

// --- port ---

export type AgentDefinitionDraftingRunnerDeps = {
  /** `resolveMyraDefinitionIdFromDb` (`./planner-run.ts`) in production. */
  readonly resolveMyraDefinitionId: (tenantId: string) => Promise<string>;
  /** `runOneShotPrompt` in production — the one boundary tests
   * stub, never live inference. */
  readonly runner: {
    run(input: {
      readonly tenantId: string;
      readonly principalId: string;
      readonly definitionId: string;
      readonly prompt: string;
      readonly timeoutMs: number;
    }): Promise<OneShotReply>;
  };
  readonly inventorySources: InventorySources;
  readonly timeoutMs?: number;
};

export type AgentDefinitionDraftingPort = {
  propose(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly name: string;
    /** Omitted for a name-only "Get started" — drafting still runs,
     * never a template fallback. */
    readonly purpose?: string;
  }): Promise<AgentDefinitionDraft>;
};

/** `purpose` is optional — a name-only "Get started" is a real happy path,
 * so this still asks Myra for a real draft: a different framing, not a
 * different code path. */
function buildAgentDefinitionDraftPrompt(
  name: string,
  purpose: string | undefined,
  inventory: PlannerInventory,
): string {
  const brief =
    purpose === undefined
      ? [
          "A person is creating a new agent named " +
            JSON.stringify(name) +
            ", with no brief yet beyond its name — they intend to teach it",
          "what to do once they're chatting with it. Draft a friendly,",
          "capable general-purpose system prompt: something that can hold",
          "a conversation, asks what the person needs, and adapts once",
          "they say more, for you to turn into a starting point for review",
          "before anything is deployed.",
        ]
      : [
          "A person is creating a new agent named " + JSON.stringify(name) + ".",
          "They described what it should do like this, for you to turn into a",
          "starting system prompt for review before anything is deployed:",
          "",
          JSON.stringify(purpose),
        ];
  const capabilityRequestGuidance = inventory.toolPackages.some(
    (entry) => entry.name === CAPABILITY_REQUEST_TOOL_PACKAGE,
  )
    ? [
        "",
        `This agent will automatically be pinned "${CAPABILITY_REQUEST_TOOL_PACKAGE}"`,
        "regardless of what you put in toolPackagePins, so its",
        "systemPrompt must tell it that it can ask for a capability (a",
        "tool package, skill, or model) it doesn't have yet by calling",
        "request_capability — only when a genuine, specific need comes",
        "up in conversation, never speculatively — and that a human has to approve the request",
        "before anything is added.",
      ]
    : [];

  return [
    ...brief,
    "",
    "Here is everything you may reference, as JSON:",
    JSON.stringify({
      models: inventory.models,
      toolPackages: inventory.toolPackages.map((entry) => entry.name),
      skills: inventory.skills,
    }),
    "",
    "Reply with ONLY a JSON object — no prose, no markdown fences — shaped",
    "exactly like this:",
    '  {"systemPrompt": "<the instructions this agent should follow on every turn>", "description": "<optional one-line refined description>", "modelPreference": "<optional model canonicalName from the inventory above, verbatim>", "toolPackagePins": ["<optional tool package name from the inventory above, verbatim>", ...], "skills": ["<optional skill name from the inventory above, verbatim>", ...]}',
    "",
    "systemPrompt is REQUIRED and should speak directly to the agent",
    '("You are..."), grounded in what the person described. It must also',
    "instruct the agent that its very first reply in a brand-new",
    "conversation should: greet the person by name, introduce itself by",
    "its own name in one line, and lead with the one concrete first step",
    "its purpose suggests — as a teammate would, never as a menu of",
    "options, and never mentioning memory, lookups, or missing context.",
    "It must also instruct the agent that when another teammate",
    "@mentions it to delegate a job, that deep-dive happens in a",
    "thread, and the agent should finish that thread with a one-line",
    "summary addressed back to whoever delegated it and to the main",
    "conversation, rather than leaving the result to be found only in",
    "the thread.",
    "systemPrompt must also give the agent an explicit output",
    "contract: what shape its replies take (lead with the answer,",
    "how long, when to ask a question instead of acting) so its",
    "behavior is predictable turn to turn, not just its topic. Name",
    "the agent's own tools in the systemPrompt by what each is for —",
    "drawn from the toolPackagePins you choose below — rather than",
    "describing its capabilities vaguely; if you choose none, the",
    "systemPrompt should say nothing about tools rather than",
    "inventing one.",
    "Every",
    "modelPreference, toolPackagePins entry, and skills entry you use",
    "MUST come from the inventory above, verbatim. Never invent one — if",
    "nothing in the inventory fits, omit that field entirely rather than",
    "guessing.",
    ...capabilityRequestGuidance,
  ].join("\n");
}

/** Builds an `AgentDefinitionDraftingPort` backed by one one-shot Myra
 * call, never trusting the reply beyond what the parse/validate pair
 * proves about it. */
export function createMyraAgentDefinitionDrafting(
  deps: AgentDefinitionDraftingRunnerDeps,
): AgentDefinitionDraftingPort {
  return {
    async propose({ tenantId, principalId, name, purpose }) {
      let definitionId: string;
      try {
        definitionId = await deps.resolveMyraDefinitionId(tenantId);
      } catch (err) {
        throw new MyraAgentDefinitionDraftingUnavailableError(
          tenantId,
          err instanceof Error ? err.message : String(err),
        );
      }

      const inventory = await assembleInventory(deps.inventorySources, {
        tenantId,
        principalId,
      });

      const draftPrompt = buildAgentDefinitionDraftPrompt(name, purpose, inventory);

      const reply = await deps.runner.run({
        tenantId,
        principalId,
        definitionId,
        prompt: draftPrompt,
        timeoutMs: deps.timeoutMs ?? DEFAULT_DRAFTING_TIMEOUT_MS,
      });

      const parsed = parseAgentDefinitionDraftReply(reply.content);
      return validateAgentDefinitionDraftReplyAgainstInventory(parsed, inventory);
    },
  };
}
