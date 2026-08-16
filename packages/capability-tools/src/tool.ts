// The `@corbits/capability-tools` bundle: `request_capability`, an
// agent's in-chat way to ask for a tool package, skill, or model it
// doesn't have yet. Declared `approval: "ask"` (`@intx/agent`'s native
// per-invocation gate, `vendor/intx/agent/src/tool.ts`) — the reactor
// suspends the call as a pending approval BEFORE this bundle's `run` ever
// executes, renders it in-chat as an approve/deny card, and only resumes
// into `run` once a human allows it. This bundle's own code never sees
// or controls that gate; it only has to make the resulting card and
// result message read honestly.
//
// [Intx gap, CL-6084]: a tool execution has no sanctioned way to learn
// its own agent definition id. `ToolCall` (`vendor/intx/types/src/runtime.ts`)
// carries only `{id, name, arguments}`; `BaseEnv` and the workflow
// runtime's per-step invoke request carry no `definitionId` field either.
// `definitionId` IS already known one layer up, at deploy time (see
// `apps/sidecar/src/workflow-host-wiring/index.ts`), but the sidecar's
// per-step env builder (`apps/sidecar/src/workflow-substrate-factory/step-env.ts`)
// — which is where `@corbits/memory-tools`' `hubMemoryUrl`/`sidecarToken`/
// `address` are threaded in today — doesn't thread it through, and
// `apps/sidecar` is outside this change's file set. `WorkflowCapabilityEnv`
// below declares `definitionId` as a required env key exactly the way
// `WorkflowMemoryEnv` declares its three; once the sidecar threads it,
// wiring is a drop-in. Until then, `env.definitionId` is never populated
// for a real run and this tool can't be pinned to a live agent.
//
// See `./client.ts` for the second, independent gap blocking the actual
// HTTP call: the capabilities route only authenticates a human session.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  addCapability,
  CapabilityOutOfInventoryError,
  fetchCapabilityInventory,
  type AddCapabilityRequest,
} from "./client";

export const REQUEST_CAPABILITY_TOOL = "request_capability";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach
 * credential, mirroring `@corbits/memory-tools`' `WorkflowMemoryEnv`,
 * plus the calling agent's own definition id (see the [Intx gap] note
 * above — not threaded by the sidecar yet). */
export interface WorkflowCapabilityEnv extends BaseEnv {
  readonly hubCapabilitiesUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
  readonly definitionId: string;
}

const RequestCapabilityInput = type({
  kind: "'tool-package'|'skill'|'model'",
  name: "string > 0",
  why: "string > 0",
  "title?": "string > 0",
});
type RequestCapabilityInput = typeof RequestCapabilityInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowCapabilityEnv) {
  return {
    hubCapabilitiesUrl: env.hubCapabilitiesUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
    definitionId: env.definitionId,
  };
}

function toAddCapabilityRequest(
  input: RequestCapabilityInput,
): AddCapabilityRequest {
  switch (input.kind) {
    case "tool-package":
      return { kind: "toolPackage", name: input.name };
    case "skill":
      return { kind: "skill", name: input.name };
    case "model":
      return { kind: "model", canonicalName: input.name };
  }
}

const KIND_LABEL: Record<RequestCapabilityInput["kind"], string> = {
  "tool-package": "tool packages",
  skill: "skills",
  model: "models",
};

/** Builds the honest "what's actually available" message an
 * out-of-inventory rejection gets, from the same inventory the route
 * just checked against — never a stale or guessed list. */
function outOfInventoryMessage(
  input: RequestCapabilityInput,
  inventory: {
    toolPackages: readonly string[];
    skills: readonly string[];
    models: readonly string[];
  },
): string {
  const available =
    input.kind === "tool-package"
      ? inventory.toolPackages
      : input.kind === "skill"
        ? inventory.skills
        : inventory.models;
  const label = KIND_LABEL[input.kind];
  return available.length === 0
    ? `"${input.name}" isn't available, and no ${label} are offered right now.`
    : `"${input.name}" isn't available. Available ${label}: ${available.join(", ")}.`;
}

async function runRequestCapability(
  env: WorkflowCapabilityEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = RequestCapabilityInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`request_capability received invalid input: ${parsed.summary}`),
    );
  }

  try {
    await addCapability(clientConfig(env), toAddCapabilityRequest(parsed));
    return {
      callId: call.id,
      isError: false,
      content: `Added ${parsed.name} — I can use it from my next reply.`,
    };
  } catch (err) {
    if (err instanceof CapabilityOutOfInventoryError) {
      try {
        const inventory = await fetchCapabilityInventory(clientConfig(env));
        return errorResult(
          call.id,
          new Error(outOfInventoryMessage(parsed, inventory)),
        );
      } catch {
        return errorResult(call.id, err);
      }
    }
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/capability-tools` bundle factory: one tool,
 * `approval: "ask"`, four env keys — the CL-6084 self-service capability
 * request path. `description` is written to read as an approval card
 * headline (`@corbits/approvals`' `headlineFor` uses a tool's
 * `description` verbatim, appending `arguments.title` in quotes when the
 * model supplies one) — encouraging the model to fill `title` with a
 * short human label makes the resulting card read naturally, e.g.
 * "<Agent> wants to add a capability: \"GitHub tools\" — Allow?".
 */
export const capabilityTools = defineTool<WorkflowCapabilityEnv>({
  id: "@corbits/capability-tools/capability",
  requires: ["hubCapabilitiesUrl", "sidecarToken", "address", "definitionId"],
  definitions: [{ name: REQUEST_CAPABILITY_TOOL, approval: "ask" }],
  factory: (env) => ({
    definitions: [
      {
        name: REQUEST_CAPABILITY_TOOL,
        description:
          "add a capability it doesn't have yet — a tool package, a " +
          "skill, or a model. Use this only when a genuine, specific " +
          "need comes up in conversation; never request a capability " +
          "speculatively. A human must approve before anything is " +
          "added, and the request is checked against what the " +
          "workspace actually offers — an unavailable request comes " +
          "back naming what's available instead.",
        inputSchema: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["tool-package", "skill", "model"],
              description: "What kind of capability this is.",
            },
            name: {
              type: "string",
              description:
                "The capability's exact name as offered in the " +
                "workspace's inventory (a tool package or skill name, " +
                "or a model's canonical name) — never invented.",
            },
            why: {
              type: "string",
              description:
                "One sentence on why this agent needs it right now, " +
                "shown to the person approving the request.",
            },
            title: {
              type: "string",
              description:
                "Optional short human-friendly label for the " +
                'capability (e.g. "GitHub tools"), shown in the ' +
                "approval card.",
            },
          },
          required: ["kind", "name", "why"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case REQUEST_CAPABILITY_TOOL:
          return runRequestCapability(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(
                `@corbits/capability-tools: unknown tool "${call.name}"`,
              ),
            ),
          );
      }
    },
  }),
});
