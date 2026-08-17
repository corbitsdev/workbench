// The `@corbits/task-dispatch-tools` bundle: `dispatch_task`, an
// agent's (Myra's) in-chat way to hand a task off to another agent —
// either one it already knows about from a prior `list_agents`/
// `create_agent` call, or left for the platform's own planner to pick
// or create. Declared `approval: "ask"` (`@intx/agent`'s native
// per-invocation gate, `vendor/intx/agent/src/tool.ts`) — the reactor
// suspends the call as a pending approval BEFORE this bundle's `run`
// ever executes, renders it in-chat as an approve/deny card, and only
// resumes into `run` once a human allows it — mirroring
// `@corbits/capability-tools`' `request_capability` exactly.
//
// This bundle never spawns a task itself: it calls the sanctioned
// workflow-run dispatch surface (`@corbits/task-planner`'s
// `createWorkflowDispatchRoutes`, `./client.ts`), which in turn reuses
// `@corbits/task-planner`'s existing `spawnFromTaskSpec`/
// `dispatchWithPlanner` machinery — the same path a person's own "let
// Myra choose" request takes through `@corbits/task-planner`'s
// tenant-session routes. No task-spawning logic is reimplemented here.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import { dispatchTask, type TaskDispatchClientConfig } from "./client";

export const DISPATCH_TASK_TOOL = "dispatch_task";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach
 * credential, mirroring `@corbits/capability-tools`'
 * `WorkflowCapabilityEnv` (`hubCapabilitiesUrl`/`sidecarToken`/
 * `address`) one-for-one, with `hubTaskPlannerUrl` in place of
 * `hubCapabilitiesUrl`. No `definitionId` is needed here — unlike
 * `request_capability`, which mutates the CALLING agent's own
 * definition, `dispatch_task` always targets a DIFFERENT agent (or
 * lets the planner choose one), so the calling agent's own identity is
 * never part of the request. */
export interface WorkflowDispatchEnv extends BaseEnv {
  readonly hubTaskPlannerUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const DispatchTaskInput = type({
  outcome: "string > 0",
  "agentDefinitionId?": "string > 0",
});
type DispatchTaskInput = typeof DispatchTaskInput.infer;

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowDispatchEnv): TaskDispatchClientConfig {
  return {
    hubTaskPlannerUrl: env.hubTaskPlannerUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

async function runDispatchTask(
  env: WorkflowDispatchEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = DispatchTaskInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`dispatch_task received invalid input: ${parsed.summary}`),
    );
  }

  try {
    const result = await dispatchTask(clientConfig(env), parsed);
    return {
      callId: call.id,
      isError: false,
      content: `Dispatched — I'll report back when it's done. (task ${result.taskId})`,
    };
  } catch (err) {
    // `TaskDispatchFailedError` (the route's fail-closed 422/400) and
    // any transport/HTTP/shape failure both read the same way to the
    // model: an honest error, never a fabricated dispatch.
    return errorResult(call.id, err);
  }
}

/**
 * The `@corbits/task-dispatch-tools` bundle factory: one tool,
 * `approval: "ask"`, three env keys — mirroring
 * `@corbits/capability-tools`' `capabilityTools` shape exactly.
 * `description` makes the two dispatch paths explicit so the model
 * knows what naming an `agentDefinitionId` does (skips the planner
 * re-ask entirely) versus omitting it (the platform picks or creates
 * an agent).
 */
export const taskDispatchTools = defineTool<WorkflowDispatchEnv>({
  id: "@corbits/task-dispatch-tools/tasks",
  requires: ["hubTaskPlannerUrl", "sidecarToken", "address"],
  definitions: [{ name: DISPATCH_TASK_TOOL, approval: "ask" }],
  factory: (env) => ({
    definitions: [
      {
        name: DISPATCH_TASK_TOOL,
        description:
          "Dispatch a task to another agent. If agentDefinitionId is " +
          "given (from a prior list_agents or create_agent call), the " +
          "task launches immediately against that agent — no further " +
          "selection step. If omitted, the platform's own planner picks " +
          "or creates a suitable agent for the outcome. A human must " +
          "approve before anything launches. This only starts the " +
          "task — it never completes it inline; report that the task " +
          "was dispatched and that you'll follow up once it's done, " +
          "never a fabricated completion.",
        inputSchema: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              description:
                "A clear statement of what the dispatched agent should " +
                "accomplish.",
            },
            agentDefinitionId: {
              type: "string",
              description:
                "Optional: the exact id of an agent already known from " +
                "a prior list_agents/create_agent call. When given, the " +
                "task launches directly against this agent, skipping " +
                "the platform's own agent-selection step. Omit to let " +
                "the platform pick or create an agent instead.",
            },
          },
          required: ["outcome"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case DISPATCH_TASK_TOOL:
          return runDispatchTask(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(
                `@corbits/task-dispatch-tools: unknown tool "${call.name}"`,
              ),
            ),
          );
      }
    },
  }),
});
