// Three tools, no approval key: listing is read-only, creation is
// tenant-internal and free (a new, deployed source asset), and messaging
// an already-deployed specialist is ordinary mail. See ./client.ts for
// the stock, workflow-run-authenticated routes each one calls.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  createAgentDefinition,
  CreateAgentDefinitionError,
  listAgentDefinitions,
  messageAgent,
  type AgentDirectoryToolClientConfig,
} from "./client";

export const LIST_AGENTS_TOOL = "list_agents";
export const CREATE_AGENT_TOOL = "create_agent";
export const MESSAGE_AGENT_TOOL = "message_agent";

export interface WorkflowAgentDirectoryEnv extends BaseEnv {
  readonly hubAgentDirectoryUrl: string;
  readonly tenantId: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const CreateAgentInput = type({
  name: "string > 0",
  systemPrompt: "string > 0",
  "modelPreference?": "string > 0",
});
type CreateAgentInput = typeof CreateAgentInput.infer;

const MessageAgentInput = type({
  address: "string > 0",
  message: "string > 0",
});
type MessageAgentInput = typeof MessageAgentInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowAgentDirectoryEnv): AgentDirectoryToolClientConfig {
  return {
    hubAgentDirectoryUrl: env.hubAgentDirectoryUrl,
    tenantId: env.tenantId,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

async function runListAgents(env: WorkflowAgentDirectoryEnv, call: ToolCall): Promise<ToolResult> {
  try {
    const definitions = await listAgentDefinitions(clientConfig(env));
    const content =
      definitions.length === 0
        ? "No other agents exist in this workbench yet."
        : definitions
            .map((definition) => `${definition.name} (message this address: ${definition.address})`)
            .join("\n");
    return { callId: call.id, isError: false, content };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runCreateAgent(env: WorkflowAgentDirectoryEnv, call: ToolCall): Promise<ToolResult> {
  const parsed = CreateAgentInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`create_agent received invalid input: ${parsed.summary}`),
    );
  }

  try {
    const created = await createAgentDefinition(clientConfig(env), {
      name: parsed.name,
      systemPrompt: parsed.systemPrompt,
      ...(parsed.modelPreference !== undefined ? { model: parsed.modelPreference } : {}),
    });
    const modelSuffix = created.modelNote !== null ? ` ${created.modelNote}` : "";
    return {
      callId: call.id,
      isError: false,
      content: `Created "${created.name}" and deployed it (message it at ${created.address}).${modelSuffix}`,
    };
  } catch (err) {
    if (err instanceof CreateAgentDefinitionError) {
      return errorResult(call.id, err);
    }
    return errorResult(call.id, err);
  }
}

async function runMessageAgent(
  env: WorkflowAgentDirectoryEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = MessageAgentInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`message_agent received invalid input: ${parsed.summary}`),
    );
  }
  try {
    await messageAgent(clientConfig(env), parsed);
    return {
      callId: call.id,
      isError: false,
      content: `Message sent to ${parsed.address}.`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/agent-directory-tools` bundle factory: `list_agents`
 * (read, no approval), `create_agent` (creation is free; the reactor
 * never parks this call), and `message_agent` — Myra's self-service
 * specialist-creation and dispatch path.
 */
export const agentDirectoryTools = defineTool<WorkflowAgentDirectoryEnv>({
  id: "@corbits/agent-directory-tools/ad",
  requires: ["hubAgentDirectoryUrl", "tenantId", "sidecarToken", "address"],
  definitions: [
    { name: LIST_AGENTS_TOOL },
    { name: CREATE_AGENT_TOOL },
    { name: MESSAGE_AGENT_TOOL },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: LIST_AGENTS_TOOL,
        description:
          "List the other taskable agents already in this workbench — " +
          "use this before creating a new one, so you never create a " +
          "duplicate of an agent that already exists, and to find an " +
          "existing agent's address before messaging it.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: CREATE_AGENT_TOOL,
        description:
          "Create and deploy a brand-new specialist agent in this " +
          "workbench, with its own name, system prompt, and mail " +
          "address. Use this only for a genuine, specific need; never " +
          "speculatively.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: 'The new agent\'s display name, e.g. "Release Notes Writer".',
            },
            systemPrompt: {
              type: "string",
              description: "The new agent's full system prompt.",
            },
            modelPreference: {
              type: "string",
              description:
                "A canonical model name from this workspace's own " +
                "connected catalog — check list_agents or a models " +
                "listing tool for real names first. Do not guess or " +
                "invent a name (e.g. a well-known provider model like " +
                '"gpt-4o") on the assumption it is available: a name ' +
                "outside this workspace's catalog is never used and " +
                "falls back to the workspace default instead. Omit " +
                "this field entirely to use that default.",
            },
          },
          required: ["name", "systemPrompt"],
        },
      },
      {
        name: MESSAGE_AGENT_TOOL,
        description: "Send a mail message to another agent in this workbench by its address.",
        inputSchema: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "The agent's mail address, from list_agents or create_agent.",
            },
            message: {
              type: "string",
              description: "The message body to send.",
            },
          },
          required: ["address", "message"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case LIST_AGENTS_TOOL:
          return runListAgents(env, call);
        case CREATE_AGENT_TOOL:
          return runCreateAgent(env, call);
        case MESSAGE_AGENT_TOOL:
          return runMessageAgent(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/agent-directory-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
