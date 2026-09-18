// `request_capability` is declared `approval: "ask"`, so the reactor
// suspends it as a pending approval before `run` ever executes; this
// bundle never sees or controls that gate. `definitionId` is threaded onto
// `env` by the sidecar's per-step env builder, the same ground
// @corbits/memory-tools' env keys come from. See ./client.ts for the
// workflow-run-authenticated route this bundle's execution calls.
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

function toAddCapabilityRequest(input: RequestCapabilityInput): AddCapabilityRequest {
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
        return errorResult(call.id, new Error(outOfInventoryMessage(parsed, inventory)));
      } catch {
        return errorResult(call.id, err);
      }
    }
    return errorResult(call.id, err);
  }
}

/** `description` is written to read as an approval-card headline, which appends `arguments.title` verbatim when supplied. */
export const capabilityTools = defineTool<WorkflowCapabilityEnv>({
  id: "@corbits/capability-tools/cap",
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
              new Error(`@corbits/capability-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
