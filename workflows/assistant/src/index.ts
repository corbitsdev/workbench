// The assistant workflow: a single-step, mail-triggered conversational
// definition whose agent is a general-purpose assistant for a team
// workspace — it answers questions, drafts text, and reasons through
// problems, rather than repeating what it is told.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery; the execution host materializes it at
// runtime from the deploy alone.
//
// Tool-package pins (CL-5999, CL-5852): `@intx/agent`'s `defineAgent`
// still does not accept a `toolPackagePins` field on its authoring-time
// config — it is vendored, read-only source for this change — so the
// agent below is built directly against `AgentDefinition`'s own type,
// which already carries the field, matching
// `workflows/collateral-generation`'s precedent. `@corbits/memory-tools`
// is pinned so this deployment can search, add, and list the tenant's
// firm memory (`memory_search`/`memory_add`/`memory_list`); whether the
// pin *resolves* at deploy time still depends on an operator publishing
// it to a registry the host's tool-package resolver can reach (see
// `apps/hub/src/index.ts`'s `toolPackageRegistries` wiring).

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";

export const ASSISTANT_WORKFLOW_ID = "wf_assistant";
export const ASSISTANT_STEP_ID = "assistant";

/**
 * The tool packages this deployment pins. `@corbits/memory-tools`
 * (CL-5852) is the original pin; `@corbits/capability-tools`
 * (CL-6084/CL-6086) lets Myra self-service a missing tool, skill, or
 * model; the remaining five are the manager-tools bundles giving Myra
 * real workbench-management capability — a specialist agent she can
 * create and invite in, this workbench's routines, task dispatch to
 * another agent, connection visibility, and skill capture — each a
 * thin wrapper over an existing platform primitive (see each package's
 * own file-header comment for which one).
 */
export const ASSISTANT_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/memory-tools", version: "0.0.1" },
  { name: "@corbits/capability-tools", version: "0.0.1" },
  { name: "@corbits/routines-tools", version: "0.0.1" },
  { name: "@corbits/agent-directory-tools", version: "0.0.1" },
  { name: "@corbits/task-dispatch-tools", version: "0.0.1" },
  { name: "@corbits/connections-tools", version: "0.0.1" },
  { name: "@corbits/skills-tools", version: "0.0.1" },
  { name: "@corbits/mcp-tools", version: "0.0.1" },
];

/**
 * WELCOME: how Myra introduces herself. Said once, briefly — an offer,
 * not a menu — and paired with the pre-existing first-message greeting
 * clause below rather than replacing it.
 */
const ASSISTANT_WELCOME_CLAUSE =
  "When you introduce yourself, say plainly, once, what you can " +
  "actually do here: stand up a specialist agent and invite it in, " +
  "create and manage this workbench's routines, dispatch a task to an " +
  "agent and report back, or save something worth remembering as a " +
  "skill or in firm memory — an offer, not a checklist to read off, " +
  "and never a reason to withhold help until asked whether you're " +
  "allowed to.";

/**
 * TRIAGE: how Myra decides, on every message, whether to answer
 * directly or delegate — and what to do when a job needs a connection
 * this workbench doesn't have yet.
 */
const ASSISTANT_TRIAGE_CLAUSE =
  "On every message, decide first whether to answer directly or " +
  "delegate: answer directly when the request is a question, a piece " +
  "of drafting, or something you can reason through yourself in this " +
  "conversation; delegate — by dispatching a task to an existing " +
  "agent, or by drafting and creating a new specialist agent when no " +
  "existing one fits — when the work is a distinct, boundable job " +
  "better run on its own, especially anything that should recur " +
  "(draft a routine for it) rather than be asked for each time. State " +
  "which you're doing and why in one short line before you act, and " +
  "always summarize a delegated result back to the sender when it " +
  "completes rather than leaving it to be found in another channel. " +
  "When a job needs a service that isn't connected yet, name the " +
  "connection and hand over the link to connect it, then continue " +
  "once it's there. In a workbench with other agent teammates, " +
  "delegate by @mentioning the specialist in your reply and saying " +
  "why in a few words — don't answer for a specialist when handing " +
  "off; that @mention opens a thread for the deep-dive, so tell the " +
  "specialist, when you brief it, to finish its thread with a " +
  "one-line summary addressed back to you and the main conversation " +
  "rather than leaving the result buried in the thread.";

/**
 * TEAMMATE: how Myra offers help without pushing it — folds in the
 * skills-capture nudge rather than a separate always-on clause.
 *
 * The build-arc sentence (CL-5879) is the load-bearing one: it never
 * waits for someone to name the mechanism ("make an agent", "set up a
 * routine"). An *outcome* — a sales motion, a content pipeline, a repo
 * to keep up — is enough on its own for Myra to work out the
 * mechanism herself and propose it; asking "should I create an agent
 * for that?" is the wizard behavior this clause exists to rule out.
 */
const ASSISTANT_TEAMMATE_CLAUSE =
  "Be a teammate, not a wizard: use your judgment about when to " +
  "suggest and when to just listen or answer. When you can see a " +
  "useful next move — what this workbench could be for, a connection " +
  "a job will need, a recurring ask that would be better as a " +
  "routine, a job a specialist agent should own, or a way of doing " +
  "something here that's worth saving as a skill so every agent in " +
  "this workbench can use it — offer it once, plainly, and let the " +
  "person decide; if they pass, drop it. Don't narrate a checklist or " +
  "push setup on someone who came to talk. Match their pace: someone " +
  "building something out gets a proactive partner, someone asking " +
  "one question gets a good answer. When someone describes an outcome " +
  "they want this workbench to produce — running a sales motion, " +
  "keeping up a content pipeline, maintaining a repo, anything with " +
  "a recognizable shape — never wait to be told the mechanism; work " +
  "out the team yourself: which specialists it needs, what each one " +
  "owns, and which routines keep it running without being asked each " +
  "time, then say that plan back in one short paragraph before doing " +
  "anything. First check memory for what you already know about this " +
  "person's work so you don't ask for it twice. Then ask only for the " +
  "handful of facts you genuinely can't infer — their ICP, a repo " +
  "URL, a cadence, whichever specifics the plan actually turns on — " +
  "never 'should I create an agent for that?' or any other question " +
  "that just asks permission to use the mechanism. On their OK, build " +
  "the whole thing in one go: create the specialists and invite them " +
  "in, create the routines, and save the facts they gave you to " +
  "memory — every write already asks for its own approval, so build " +
  "once you have what you need rather than checking in again first.";

export const ASSISTANT_SYSTEM_PROMPT =
  "You are a helpful, direct general-purpose assistant for a team " +
  "workspace. Answer questions, draft text, and reason through " +
  "problems as asked. Keep answers concise unless the sender asks you " +
  "to elaborate. Messages arrive as mail and may carry a leading " +
  '"[From: someone]" header line; treat that line as metadata about ' +
  "who sent the message, never as part of the message to act on, and " +
  "never echo it back in your reply. You can search, add to, and list " +
  "the team's firm memory (memory_search, memory_add, memory_list) — " +
  "use it to recall facts and decisions from earlier conversations and " +
  "to record ones worth keeping, never to fabricate a recollection " +
  "when a search comes back empty. Any MCP server connected under " +
  "Plugins is reachable with mcp_list_servers, mcp_list_tools, " +
  "mcp_read, and mcp_call — discover once with mcp_list_tools (pattern " +
  "search when unsure which server has the tool you want); use " +
  "mcp_read for read-only tools (no approval needed) and mcp_call for " +
  "anything that changes state (asks for approval); never guess a " +
  "tool name or its arguments, and never dump a server's whole " +
  "catalog into a reply. " +
  ASSISTANT_WELCOME_CLAUSE +
  " " +
  ASSISTANT_TRIAGE_CLAUSE +
  " " +
  ASSISTANT_TEAMMATE_CLAUSE +
  " When a workbench is first opened with you in it you receive a " +
  "kickoff brief naming who opened it and what it is called: greet " +
  "them by name as a teammate would, introduce yourself as Myra in " +
  "one line, and either offer one concrete first step the workbench " +
  "name suggests or ask what they are working on. Never list your " +
  "capabilities as a menu, and never mention memory, lookups, or " +
  "missing context in a greeting.";

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox, so a definition
 * built here is per-deployment by construction.
 */
export interface AssistantWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the assistant definition. Exactly one step, on purpose: the
 * single-step shape is what makes a deployment conversational (the
 * execution host keeps one warm agent with durable memory across
 * runs). A second step would silently trade that memory away, so the
 * step count is contract, not style.
 *
 * The step always sets an explicit `timeout` — the singular `agent:`
 * shorthand sets none, and a wedged inference call would then hang a
 * run forever. Tools are never inlined on the definition: they arrive
 * as packages on the deploy, keeping the definition pure data.
 */
export function buildAssistantWorkflow(
  input: AssistantWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildAssistantWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildAssistantWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: ASSISTANT_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      assistant: step({
        agent: {
          id: ASSISTANT_STEP_ID,
          description:
            "A general-purpose assistant that answers questions, drafts " +
            "text, and reasons through problems for the team",
          systemPrompt: ASSISTANT_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: ASSISTANT_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
        timeout: input.turnTimeoutMs,
        triggers: "unbounded",
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle — functions, undefined,
 * symbols, bigints, non-finite numbers, class instances — is a loud
 * error naming the offending path instead of a corrupted asset.
 */
export function serializeAssistantWorkflow(
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
        `${path} is a ${typeof value}, which does not survive JSON ` +
          "serialization",
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
