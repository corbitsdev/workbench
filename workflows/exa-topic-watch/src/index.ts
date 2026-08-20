// The exa-topic-watch workflow: on a schedule, search the live web for
// one topic and publish a short digest of what moved. Ported from the OG
// gtm-workbench's `exa-topic-watch` workflow (CL-6349).
//
// ## What the OG pipeline does, step by step
// intake (awaitSignal, a topic) -> prepare-search (action: a
// workflow-owned tool renaming `topic` to exa_search's `query` argument)
// -> fetch (action: `exa_search`) -> digest (reasoning: write the
// markdown digest) -> document (action: pair topic + reply into
// `{ title, body }`) -> persist (action: `write_artifact`).
//
// ## Adaptations this port makes
//
// (1) Folded to one step. Five of the OG's six steps were native
// `action` primitives dispatching a `handler` string an `ActionInvoker`
// resolves. This repo's production host leaves `invokeAction` undefined
// (`vendor/intx/workflow/src/runtime/run.ts` throws "this host does not
// support action primitives"), so an `action` step here would deploy as
// something nothing can dispatch. Every OG action collapses into the
// single reasoning step below, which calls the same capabilities as
// ordinary agent tools inside one turn — the shape every proven workflow
// package in this repo already uses. Folding also removes the OG's
// `prepare-search` rename tool outright: an agent naming a search
// tool's own arguments has nothing left to rename.
//
// (2) Exa reaches this deployment through the Exa MCP preset
// (`packages/connections/src/mcp-presets.ts`, slug `exa`, keyless) and
// `@corbits/mcp-tools`' `mcp_read`, rather than the OG's bespoke
// `@workbench/tools-exa` package. `@corbits/mcp-tools` is one of the few
// tool packages this repo actually publishes to its own registry
// (`packages/tool-registry-publish/src/registry.ts`), so a pin on it
// resolves at deploy time; a pin on a native Exa bundle would not.
// The MCP credential handle (`mcp:exa`) is dynamic tenant data, so the
// host supplies its binding per tenant
// (`apps/hub/src/mcp-credential-bindings.ts`) — this definition declares
// no static credential binding of its own.
//
// (3) Persistence is `exa_topic_watch_finalize` (`approval: "ask"`,
// `./finalize-tool.ts`) rather than the OG's ungated `write_artifact`
// action. Every external side effect in this repo sits behind human
// approval (`AGENTS.md`), and this is the only path from a workflow tool
// package to the Library engine here.
//
// (4) Intake: the OG parks on `awaitSignal("intake")`. Workbench collects
// the topic on the routine *before* launch and delivers it as the
// first-turn mail (`renderRoutineInput` -> `trigger.payload`), so a gate
// nobody fulfills would hang the run forever. The triggering mail *is*
// the topic.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import { EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME } from "./finalize-tool";

export const EXA_TOPIC_WATCH_WORKFLOW_ID = "wf_exa_topic_watch";
export const EXA_TOPIC_WATCH_STEP_ID = "exa-topic-watch-digest";

/** The MCP preset slug this watch searches through — the same slug
 * `packages/connections/src/mcp-presets.ts` registers Exa under, and the
 * one the agent passes as `mcp_read`'s `server` argument. */
export const EXA_MCP_SERVER_SLUG = "exa";

/** The digest's fixed section structure — this deployment's contract, and
 * what the system prompt below instructs the model to fill in. */
export const EXA_TOPIC_WATCH_SECTIONS = [
  "What moved",
  "Takeaways",
  "Worth a closer look",
] as const;

const CORBITS_VOCABULARY =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical " +
  "Corbits names; spell them exactly. When source material contains a " +
  "clear speech-to-text or spelling variant, use the canonical spelling " +
  "in your output. Do not replace an ambiguous term unless surrounding " +
  "context identifies it.";

export const EXA_TOPIC_WATCH_SYSTEM_PROMPT = [
  CORBITS_VOCABULARY,
  "You are a scheduled web topic watch. Each run, you read one topic " +
    "from the message that started you and report what moved on it since " +
    "the last run. Nobody is watching this run happen — write for someone " +
    "reading it later, cold.",
  "The message carries a `topic`. It is the whole brief: never invent a " +
    "topic, and never widen one. If it is missing or empty, skip searching " +
    "entirely and finalize a status note saying what a topic looks like.",
  `Searching: web search reaches you through the "${EXA_MCP_SERVER_SLUG}" server. Call \`mcp_list_tools\` once for that server to learn its search tool's exact name and arguments, then call \`mcp_read\` at most three times, each with a differently-angled query for the same topic. If the server is not connected, or a call comes back as an error, that is an honest "the web is not reachable right now" — say so plainly, and never invent results to cover for it.`,
  `Write the digest as markdown with exactly these sections, in order: ${EXA_TOPIC_WATCH_SECTIONS.join(", ")}. "What moved" is one line. "Takeaways" is three to seven bullets, each linking its source. "Worth a closer look" is at most three items, each with one sentence on why. No preamble.`,
  "Every claim carries the link it came from. A claim you cannot link " +
    "does not go in.",
  `Finalizing: call \`${EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME}\` exactly once with outcome "digest", a short title (e.g. "Web topic watch: <topic>"), and the full markdown digest as content. This call requires a human's approval before it completes. A quiet run is still a run: when nothing new surfaced, or the web was unreachable, call the same tool once with outcome "status-note", a plain title (e.g. "Web topic watch: <topic> — quiet week"), and content that honestly says what you searched for and what you found or could not reach. Never end a run without finalizing.`,
  "If the finalize call succeeds, present the digest as your reply " +
    "exactly as written, with no commentary about the approval mechanism " +
    "itself. If the call is denied, reply with one calm, plain sentence " +
    "that the digest was not published and nothing was saved; never " +
    "present a denial as an error, and never apologize as if something " +
    "broke.",
].join("\n\n");

/**
 * Tool packages this definition pins (CL-5999). `@corbits/mcp-tools`
 * carries every connected MCP server, Exa among them; the finalize tool
 * travels with the deploy of this package itself.
 */
export const EXA_TOPIC_WATCH_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/mcp-tools", version: "0.0.6" },
];

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a Routine's scheduled trigger mail lands on.
 */
export interface ExaTopicWatchWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the exa-topic-watch definition: exactly one mail-triggered
 * reasoning step whose triggering mail carries the watch topic. Tools are
 * never inlined on the definition — they arrive as pinned packages on the
 * deploy, keeping the definition pure data.
 */
export function buildExaTopicWatchWorkflow(
  input: ExaTopicWatchWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildExaTopicWatchWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildExaTopicWatchWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: EXA_TOPIC_WATCH_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [EXA_TOPIC_WATCH_STEP_ID]: step({
        agent: {
          id: EXA_TOPIC_WATCH_STEP_ID,
          description:
            "Searches the live web for one topic and publishes a short " +
            "digest of what moved, once a human approves it",
          systemPrompt: EXA_TOPIC_WATCH_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: EXA_TOPIC_WATCH_TOOL_PACKAGE_PINS,
        } satisfies AgentDefinition,
        timeout: input.turnTimeoutMs,
      }),
    },
  });
}

/**
 * Serializes a definition to the JSON a workflow asset carries. The
 * definition must survive the asset round-trip byte-faithfully, so
 * anything JSON would silently drop or mangle is a loud error naming the
 * offending path instead of a corrupted asset.
 */
export function serializeExaTopicWatchWorkflow(
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

export {
  EXA_TOPIC_WATCH_FINALIZE_TOOL,
  EXA_TOPIC_WATCH_FINALIZE_TOOL_NAME,
  EXA_TOPIC_WATCH_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
