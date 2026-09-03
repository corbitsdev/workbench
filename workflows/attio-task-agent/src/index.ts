// The attio-task-agent workflow: works one CRM task end to end —
// grounds itself in the record and the surrounding context read-only,
// drafts what the task needs, and writes back to the CRM only once a
// human approves. Ported from the OG gtm-workbench's `attio-task-agent`
// (CL-6349).
//
// ## What the OG pipeline does, step by step
// listMembers -> memberSelectGate -> selectMember -> listTasks ->
// taskSelectGate -> selectTask -> fetchTask -> analyze (a read-only ReAct
// planner) -> clarifyGate -> clarify -> execute (writer) ->
// reviewArtifacts (judge) -> reviewGate -> review -> persist -> suggest
// -> syncApprovalGate -> approveSync -> syncGate -> writeNote ->
// writeComplete, with skipWriteBack as the decline leaf. Sixteen of
// those twenty-one steps were native `action` or `awaitSignal`
// primitives; four were reasoning steps.
//
// ## Adaptations this port makes
//
// (1) Folded to one reasoning step. Every OG `action` dispatches a
// `handler` string an `ActionInvoker` resolves, and this repo's
// production host leaves `invokeAction` undefined
// (`vendor/intx/workflow/src/runtime/run.ts` throws "this host does not
// support action primitives"). Every OG `awaitSignal` gate likewise needs a
// stepper UI to fulfil it, and a gate nobody fulfils hangs a run forever.
// Both collapse into the single reasoning step below: the planner /
// writer / reviewer / suggest phases become four named phases of one
// prompt (`./prompts.ts`), and the selection and clarification gates
// become the agent asking in the thread — the person is already there.
//
// (2) The CRM reaches this deployment through the Attio MCP preset
// (`packages/connections/src/mcp-presets.ts`, slug `attio`, OAuth) and
// `@corbits/mcp-tools`, rather than the OG's bespoke
// `@workbench/tools-attio` package. `@corbits/mcp-tools` is one of the
// few tool packages this repo publishes to its own registry
// (`packages/tool-registry-publish/src/registry.ts`), so a pin on it
// resolves at deploy time. Past calls (Granola) and the live web (Exa)
// come through the same bundle when their presets are connected — a
// connected server the agent can read, not a hard dependency.
//
// (3) The write-back gate is kept, not weakened. The OG gated it on an
// explicit `confirm` signal followed by fatal `attio_create_note` /
// `attio_update_task` actions. Here the same gate is `mcp_call`, which
// `@corbits/mcp-tools` declares `approval: "ask"` unconditionally: the
// run suspends and a human approves the exact call before anything
// reaches the CRM. Reads go through `mcp_read`, which refuses any tool
// the server does not mark read-only — so "never mutate while grounding"
// is enforced by the tool, not only by the prompt.
//
// (4) The OG's `gamma-presentation` draft kind is dropped: it existed to
// hand off to a Gamma tool package this deployment does not have, and a
// kind nothing can act on is a promise the run cannot keep. Every other
// kind is carried over (`./prompts.ts`).
//
// (5) Persistence is `attio_task_agent_finalize` (`approval: "ask"`,
// `./finalize-tool.ts`) rather than the OG's batch persist action — the
// only path from a workflow tool package to the Library engine here, and
// the shape this repo's approval and delivery pipelines already read.
//
// This package is installable data. It imports only published platform
// packages, and nothing imports it statically: a host publishes the
// serialized definition as a workflow asset and deploys it through the
// platform's deploy machinery.

import type { AgentDefinition, InferencePreference } from "@intx/agent";
import { defineWorkflow, step } from "@intx/workflow";
import type { WorkflowDefinition } from "@intx/workflow";
import type { ToolPackagePin } from "@intx/types/tool-packages";

import { ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME } from "./finalize-tool";
import { buildAttioTaskAgentSystemPrompt } from "./prompts";

export const ATTIO_TASK_AGENT_WORKFLOW_ID = "wf_attio_task_agent";
export const ATTIO_TASK_AGENT_STEP_ID = "attio-task-agent-work";

/** The MCP preset slug the CRM is connected under — the same slug
 * `packages/connections/src/mcp-presets.ts` registers Attio under, and
 * the one the agent passes as `mcp_read` / `mcp_call`'s `server`. */
export const ATTIO_MCP_SERVER_SLUG = "attio";

export const ATTIO_TASK_AGENT_SYSTEM_PROMPT = buildAttioTaskAgentSystemPrompt({
  attioServerSlug: ATTIO_MCP_SERVER_SLUG,
  finalizeToolName: ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
});

/**
 * Tool packages this definition pins (CL-5999). `@corbits/mcp-tools`
 * carries every connected MCP server — the CRM, and whatever meetings or
 * web-search server the workbench also has — so one pin covers all three
 * of the OG's separate tool packages. The finalize tool travels with the
 * deploy of this package itself.
 */
export const ATTIO_TASK_AGENT_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/mcp-tools", version: "0.0.11" },
];

/**
 * Everything the definition needs that is per-deployment data. The
 * trigger address names a specific deployment's inbox — for this
 * workflow, the address a person messages to start work on a task.
 */
export interface AttioTaskAgentWorkflowInput {
  /** The deployment's mail address; each inbound mail is one run. */
  readonly triggerAddress: string;
  /** Provider/model preferences, in order; resolved at deploy time. */
  readonly inferencePreferences: readonly InferencePreference[];
  /** Per-turn timeout in milliseconds, enforced on the single step. */
  readonly turnTimeoutMs: number;
}

/**
 * Builds the attio-task-agent definition: exactly one mail-triggered
 * reasoning step whose triggering mail names the task to work. Tools are
 * never inlined on the definition — they arrive as pinned packages on the
 * deploy, keeping the definition pure data.
 */
export function buildAttioTaskAgentWorkflow(
  input: AttioTaskAgentWorkflowInput,
): WorkflowDefinition {
  if (input.triggerAddress === "") {
    throw new Error(
      "buildAttioTaskAgentWorkflow requires a non-empty triggerAddress",
    );
  }
  if (!Number.isInteger(input.turnTimeoutMs) || input.turnTimeoutMs <= 0) {
    throw new Error(
      "buildAttioTaskAgentWorkflow requires turnTimeoutMs to be a positive integer",
    );
  }
  return defineWorkflow({
    id: ATTIO_TASK_AGENT_WORKFLOW_ID,
    trigger: { type: "mail", to: input.triggerAddress },
    steps: {
      [ATTIO_TASK_AGENT_STEP_ID]: step({
        agent: {
          id: ATTIO_TASK_AGENT_STEP_ID,
          description:
            "Works one CRM task: grounds itself read-only, drafts what " +
            "the task needs, and writes back only once a human approves",
          systemPrompt: ATTIO_TASK_AGENT_SYSTEM_PROMPT,
          toolFactories: [],
          capabilities: [],
          inference: { sources: input.inferencePreferences },
          toolPackagePins: ATTIO_TASK_AGENT_TOOL_PACKAGE_PINS,
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
export function serializeAttioTaskAgentWorkflow(
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
  ATTIO_TASK_ARTIFACT_KINDS,
  ARTIFACT_KIND_GUIDANCE,
  buildAttioTaskAgentSystemPrompt,
} from "./prompts";
export type { AttioTaskArtifactKind } from "./prompts";
export {
  ATTIO_TASK_AGENT_FINALIZE_TOOL,
  ATTIO_TASK_AGENT_FINALIZE_TOOL_NAME,
  ATTIO_TASK_AGENT_FINALIZE_DESCRIPTION,
  buildArtifactPayload,
} from "./finalize-tool";
export type { ArtifactPayload, FinalizeArgs } from "./finalize-tool";
