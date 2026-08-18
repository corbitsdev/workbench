// The `@corbits/agent-directory-tools` bundle: Myra's manager tools —
// `list_agents`, a plain read of the tenant's taskable agents, and
// `create_agent`, which materializes a brand-new specialist agent
// definition and, by default, invites it straight into the channel
// Myra is talking in. `create_agent` is declared `approval: "ask"`
// (`@intx/agent`'s native per-invocation gate, `vendor/intx/agent/src/tool.ts`)
// — the reactor suspends the call as a pending approval BEFORE this
// bundle's `run` ever executes, renders it in-chat as an approve/deny
// card, and only resumes into `run` once a human allows it. This
// bundle's own code never sees or controls that gate. Reviewed under
// CL-6209's grant-free-write policy and kept as `ask`, deliberately:
// `create_agent` can pin `toolPackagePins` directly onto the new
// definition (a capability grant), invites the new agent into the
// channel by default, and materializes a brand-new autonomous agent —
// none of that is a plain tenant-internal state write.
//
// `hubAgentDirectoryUrl`/`hubChatUrl`/`sidecarToken`/`address` are
// threaded onto `env` by the sidecar's per-step env builder, the same
// ground `@corbits/memory-tools`'/`@corbits/capability-tools`' own env
// keys are threaded from.
//
// See `./client.ts` for the two workflow-run-authenticated routes this
// bundle's execution calls: `@corbits/agent-directory`'s
// `createWorkflowAgentCreateRoutes` and `@corbits/chat`'s
// `createWorkflowParticipantRoutes`.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  createAgentDefinition,
  CreateAgentDefinitionError,
  inviteParticipant,
  listAgentDefinitions,
  NoOwnChannelError,
  type AgentDirectoryToolClientConfig,
  type CreateAgentDefinitionRequest,
} from "./client";

export const LIST_AGENTS_TOOL = "list_agents";
export const CREATE_AGENT_TOOL = "create_agent";

export interface WorkflowAgentDirectoryEnv extends BaseEnv {
  readonly hubAgentDirectoryUrl: string;
  readonly hubChatUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const CreateAgentInput = type({
  name: "string > 0",
  systemPrompt: "string > 0",
  "toolPackagePins?": type("string > 0").array(),
  "skills?": type("string > 0").array(),
  "modelPreference?": "string > 0",
  "invite?": "boolean",
});
type CreateAgentInput = typeof CreateAgentInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(
  env: WorkflowAgentDirectoryEnv,
): AgentDirectoryToolClientConfig {
  return {
    hubAgentDirectoryUrl: env.hubAgentDirectoryUrl,
    hubChatUrl: env.hubChatUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

/** A definition handle derived from its display name — lowercased,
 * non-alphanumeric runs collapsed to a single hyphen, leading/trailing
 * hyphens trimmed — mirroring `@corbits/chat`'s `handleFromName` slug
 * rule closely enough to produce a valid `HANDLE_PATTERN` match without
 * depending on `@corbits/chat` from this bundle. A name that yields
 * nothing usable falls back to a generic handle rather than sending the
 * create route an empty string it would reject. */
function handleFromAgentName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "agent";
}

function toCreateAgentDefinitionRequest(
  input: CreateAgentInput,
): CreateAgentDefinitionRequest {
  const request: {
    name: string;
    handle: string;
    systemPrompt: string;
    model?: string;
    skills?: readonly string[];
    toolPackagePins?: readonly string[];
  } = {
    name: input.name,
    handle: handleFromAgentName(input.name),
    systemPrompt: input.systemPrompt,
  };
  if (input.modelPreference !== undefined)
    request.model = input.modelPreference;
  if (input.skills !== undefined) request.skills = input.skills;
  if (input.toolPackagePins !== undefined) {
    request.toolPackagePins = input.toolPackagePins;
  }
  return request;
}

async function runListAgents(
  env: WorkflowAgentDirectoryEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const definitions = await listAgentDefinitions(clientConfig(env));
    const content =
      definitions.length === 0
        ? "No other agents exist in this workbench yet."
        : definitions
            .map((definition) =>
              definition.description !== null
                ? `${definition.name} — ${definition.description} (use this id for routines/dispatch: ${definition.id})`
                : `${definition.name} (use this id for routines/dispatch: ${definition.id})`,
            )
            .join("\n");
    return { callId: call.id, isError: false, content };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runCreateAgent(
  env: WorkflowAgentDirectoryEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = CreateAgentInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`create_agent received invalid input: ${parsed.summary}`),
    );
  }

  let created;
  try {
    created = await createAgentDefinition(
      clientConfig(env),
      toCreateAgentDefinitionRequest(parsed),
    );
  } catch (err) {
    if (err instanceof CreateAgentDefinitionError) {
      return errorResult(call.id, err);
    }
    return errorResult(call.id, err);
  }

  // `invite` defaults to `true` — never require the model to pass it,
  // only to opt out explicitly.
  const shouldInvite = call.arguments["invite"] !== false;
  if (!shouldInvite) {
    return {
      callId: call.id,
      isError: false,
      content: `Created "${created.name}" (use this id for routines/dispatch: ${created.id}). It is not in this channel — invite it explicitly if you want it here.`,
    };
  }

  try {
    await inviteParticipant(clientConfig(env), created.id);
    return {
      callId: call.id,
      isError: false,
      content: `Created "${created.name}" (use this id for routines/dispatch: ${created.id}) and invited it into this channel.`,
    };
  } catch (err) {
    // The agent was genuinely created — that half-success must never
    // be dropped or reported as a bare error. A completed (not error)
    // result whose content names the create-succeeded/invite-failed
    // split, and why, so the model can relay it honestly rather than
    // claiming either full success or total failure.
    const reason =
      err instanceof NoOwnChannelError
        ? "this channel could not be identified as the caller's own"
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      callId: call.id,
      isError: false,
      content: `Created "${created.name}" (use this id for routines/dispatch: ${created.id}), but could not invite it into this channel: ${reason}.`,
    };
  }
}

/**
 * The `@corbits/agent-directory-tools` bundle factory: `list_agents`
 * (read, no approval) and `create_agent` (`approval: "ask"`) — Myra's
 * CL-manager-tools self-service specialist-creation path.
 */
export const agentDirectoryTools = defineTool<WorkflowAgentDirectoryEnv>({
  id: "@corbits/agent-directory-tools/ad",
  requires: ["hubAgentDirectoryUrl", "hubChatUrl", "sidecarToken", "address"],
  definitions: [
    { name: LIST_AGENTS_TOOL },
    { name: CREATE_AGENT_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: LIST_AGENTS_TOOL,
        description:
          "List the other taskable agents already in this workbench — " +
          "use this before creating a new one, so you never create a " +
          "duplicate of an agent that already exists.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: CREATE_AGENT_TOOL,
        description:
          "Create a brand-new specialist agent in this workbench, with " +
          "its own name and system prompt, and — unless told not to — " +
          "invite it straight into this channel. A human must approve " +
          "before anything is created. Use this only for a genuine, " +
          "specific need; never speculatively.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description:
                'The new agent\'s display name, e.g. "Release Notes Writer".',
            },
            systemPrompt: {
              type: "string",
              description: "The new agent's full system prompt.",
            },
            toolPackagePins: {
              type: "array",
              items: { type: "string" },
              description:
                "Tool package names to pin directly onto the new agent " +
                '(e.g. "@corbits/memory-tools"), if it needs one beyond ' +
                "what its skills already pull in.",
            },
            skills: {
              type: "array",
              items: { type: "string" },
              description: "Skill names to pin onto the new agent.",
            },
            modelPreference: {
              type: "string",
              description:
                "A canonical model name for the new agent, or omitted " +
                "to use the workspace's catalog default.",
            },
            invite: {
              type: "boolean",
              description:
                "Whether to invite the new agent into this channel " +
                "immediately after creating it. Defaults to true — " +
                "pass false to create the agent without inviting it.",
            },
          },
          required: ["name", "systemPrompt"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case LIST_AGENTS_TOOL:
          return runListAgents(env, call);
        case CREATE_AGENT_TOOL:
          return runCreateAgent(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(
                `@corbits/agent-directory-tools: unknown tool "${call.name}"`,
              ),
            ),
          );
      }
    },
  }),
});
