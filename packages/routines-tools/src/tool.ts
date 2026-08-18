// The `@corbits/routines-tools` bundle: `routine_list`, `routine_create`,
// `routine_update`, and `routine_run_now` — Myra's in-chat way to manage
// the workbench's recurring/triggered automations.
//
// Only `routine_run_now` declares `approval: "ask"` (`@intx/agent`'s
// native per-invocation gate): it fires a routine's target agent
// definition immediately, taking whatever external action that
// definition's own already-granted capabilities allow — the reactor
// suspends the call as a pending approval BEFORE this bundle's `run`
// ever executes, renders it in-chat as an approve/deny card, and only
// resumes into `run` once a human allows it, the same shape
// `@corbits/capability-tools`' `request_capability` uses.
//
// `routine_create` and `routine_update` (CL-6209) grant no credentials
// or capability pins and write only a tenant-internal routine row —
// scheduling metadata pointing at a definitionId whose own capabilities
// were already approved separately. Neither call touches anything
// external itself, so neither carries an `approval` key; the human gate
// that matters is the one on the definition's own tools, which fires
// again every time the routine actually runs. `routine_list` is
// read-only and carries no `approval` key either, mirroring
// `@corbits/memory-tools`' `memory_list`.
//
// `definitionId` is a required input on `routine_create`, never
// auto-resolved: Myra must name the agent definition a routine runs
// against, typically one she already knows from a prior `list_agents` /
// `create_agent` call — this bundle has no opinion on which definition
// is "right" for a given routine.
//
// See `./client.ts` for the workflow-run-authenticated routine routes
// (`@corbits/routines`' `createWorkflowRoutineRoutes`) this bundle's
// execution calls.
import { defineTool } from "@intx/agent";
import type { BaseEnv } from "@intx/agent";
import type { ToolCall, ToolResult } from "@intx/types/runtime";
import { type } from "arktype";

import {
  createRoutine,
  listRoutines,
  runRoutineNow,
  updateRoutine,
  type RoutineTriggerInput,
} from "./client";

export const ROUTINE_LIST_TOOL = "routine_list";
export const ROUTINE_CREATE_TOOL = "routine_create";
export const ROUTINE_UPDATE_TOOL = "routine_update";
export const ROUTINE_RUN_NOW_TOOL = "routine_run_now";

/** Env this bundle needs beyond `BaseEnv`: the run's hub-reach
 * credential, mirroring `@corbits/memory-tools`' `WorkflowMemoryEnv` —
 * no `definitionId` env key, since this bundle is tenant-scoped, not
 * self-definition-scoped (Myra manages routines against ANY definition
 * in her tenant, not just her own). */
export interface WorkflowRoutineEnv extends BaseEnv {
  readonly hubRoutinesUrl: string;
  readonly sidecarToken: string;
  readonly address: string;
}

const TriggerInput = type({
  kind: "'daily'",
  hour: "0 <= number.integer <= 23",
  minute: "0 <= number.integer <= 59",
  "timezone?": "string > 0",
})
  .or({
    kind: "'weekly'",
    dayOfWeek: "0 <= number.integer <= 6",
    hour: "0 <= number.integer <= 23",
    minute: "0 <= number.integer <= 59",
    "timezone?": "string > 0",
  })
  .or({
    kind: "'cron'",
    expression: "string > 0",
    "timezone?": "string > 0",
  })
  .or({
    kind: "'webhook'",
    webhookTriggerId: "string > 0",
  });

const RoutineCreateInput = type({
  name: "string > 0",
  definitionId: "string > 0",
  instruction: "string > 0",
  trigger: TriggerInput,
  "enabled?": "boolean",
});
type RoutineCreateInput = typeof RoutineCreateInput.infer;

const RoutineUpdateInput = type({
  id: "string > 0",
  "enabled?": "boolean",
  "name?": "string > 0",
  "instruction?": "string > 0",
  "trigger?": TriggerInput,
});
type RoutineUpdateInput = typeof RoutineUpdateInput.infer;

const RoutineRunNowInput = type({
  id: "string > 0",
});

/** A correct, minimal trigger literal — surfaced in validation error
 * messages so a model that sent a malformed trigger has one concrete
 * shape to self-correct against on its next call. */
const TRIGGER_EXAMPLE = '{"kind":"daily","hour":8,"minute":0}';

/**
 * Local models are observed sending object-valued tool arguments —
 * `trigger` chief among them — as a JSON-encoded string rather than a
 * structured object. Decodes one level; a value double-encoded (a
 * string containing a string containing JSON) gets one extra decode
 * attempt. Anything that isn't a JSON-encoded string, or that fails to
 * parse, passes through unchanged so the real validator reports it.
 */
function decodeMaybeJsonString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const once: unknown = JSON.parse(value);
    if (typeof once === "string") {
      try {
        return JSON.parse(once);
      } catch {
        return once;
      }
    }
    return once;
  } catch {
    return value;
  }
}

/**
 * Tolerates the near-miss trigger shapes local models send in place of
 * `RoutineTrigger`'s canonical fields: `trigger` as a JSON string
 * (`decodeMaybeJsonString` above), `type` where `kind` belongs, `expr`
 * where the cron trigger's `expression` belongs, and a daily/weekly
 * `time: "HH:MM"` string in place of separate `hour`/`minute` numbers.
 * Never guesses at free-text schedules ("every day at 8") — only
 * decodes and renames fields a model plausibly meant literally.
 */
function coerceTriggerInput(value: unknown): unknown {
  const decoded = decodeMaybeJsonString(value);
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    return decoded;
  }
  const trigger = { ...(decoded as Record<string, unknown>) };
  if (trigger.kind === undefined && typeof trigger.type === "string") {
    trigger.kind = trigger.type;
  }
  delete trigger.type;
  if (
    trigger.kind === "cron" &&
    trigger.expression === undefined &&
    typeof trigger.expr === "string"
  ) {
    trigger.expression = trigger.expr;
  }
  delete trigger.expr;
  if (
    (trigger.kind === "daily" || trigger.kind === "weekly") &&
    typeof trigger.time === "string"
  ) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(trigger.time);
    if (match) {
      trigger.hour = trigger.hour ?? Number(match[1]);
      trigger.minute = trigger.minute ?? Number(match[2]);
    }
  }
  delete trigger.time;
  return trigger;
}

/** Applies `coerceTriggerInput` to a call's `trigger` argument, if
 * present, before the strict `TriggerInput` schema sees it. */
function coerceRoutineArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!("trigger" in args)) return args;
  return { ...args, trigger: coerceTriggerInput(args.trigger) };
}

function invalidInputError(toolName: string, summary: string): Error {
  return new Error(
    `${toolName} received invalid input: ${summary} Example of a ` +
      `valid trigger: ${TRIGGER_EXAMPLE}`,
  );
}

function errorResult(callId: string, err: unknown): ToolResult {
  return {
    callId,
    isError: true,
    content: err instanceof Error ? err.message : String(err),
  };
}

function clientConfig(env: WorkflowRoutineEnv) {
  return {
    hubRoutinesUrl: env.hubRoutinesUrl,
    sidecarToken: env.sidecarToken,
    address: env.address,
  };
}

/**
 * `instruction` maps to the routine's stored `input`. `@corbits/routines`'
 * own `renderRoutineInput` (`packages/routines/src/render-input.ts`)
 * renders any `Record<string, unknown>` as `key: value` lines a launched
 * run reads as its first-turn message — `{instruction: <text>}` is the
 * simplest record that survives that rendering intact, one labeled line
 * carrying Myra's free-text instruction verbatim. A workflow definition
 * expecting a richer input shape (multiple named fields) isn't served by
 * this simplification; that's future scope, not something this bundle
 * invents an opinion on today.
 */
function toRoutineInput(instruction: string): Record<string, unknown> {
  return { instruction };
}

async function runRoutineList(
  env: WorkflowRoutineEnv,
  call: ToolCall,
): Promise<ToolResult> {
  try {
    const items = await listRoutines(clientConfig(env));
    return {
      callId: call.id,
      isError: false,
      content: JSON.stringify({ items }),
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runRoutineCreate(
  env: WorkflowRoutineEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = RoutineCreateInput(
    coerceRoutineArguments(call.arguments as Record<string, unknown>),
  );
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      invalidInputError(ROUTINE_CREATE_TOOL, parsed.summary),
    );
  }
  try {
    const routine = await createRoutine(clientConfig(env), {
      name: parsed.name,
      definitionId: parsed.definitionId,
      trigger: parsed.trigger as RoutineTriggerInput,
      input: toRoutineInput(parsed.instruction),
    });
    if (parsed.enabled === false) {
      await updateRoutine(clientConfig(env), routine.id, { enabled: false });
    }
    return {
      callId: call.id,
      isError: false,
      content: `Created "${parsed.name}" (${routine.id}).`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runRoutineUpdate(
  env: WorkflowRoutineEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = RoutineUpdateInput(
    coerceRoutineArguments(call.arguments as Record<string, unknown>),
  );
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      invalidInputError(ROUTINE_UPDATE_TOOL, parsed.summary),
    );
  }
  const patch: {
    enabled?: boolean;
    name?: string;
    trigger?: RoutineTriggerInput;
    input?: Record<string, unknown>;
  } = {};
  if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
  if (parsed.name !== undefined) patch.name = parsed.name;
  if (parsed.trigger !== undefined) {
    patch.trigger = parsed.trigger as RoutineTriggerInput;
  }
  if (parsed.instruction !== undefined) {
    patch.input = toRoutineInput(parsed.instruction);
  }
  try {
    const routine = await updateRoutine(clientConfig(env), parsed.id, patch);
    return {
      callId: call.id,
      isError: false,
      content: `Updated "${routine.name}" (${routine.id}).`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

async function runRoutineRunNow(
  env: WorkflowRoutineEnv,
  call: ToolCall,
): Promise<ToolResult> {
  const parsed = RoutineRunNowInput(call.arguments);
  if (parsed instanceof type.errors) {
    return errorResult(
      call.id,
      new Error(`routine_run_now received invalid input: ${parsed.summary}`),
    );
  }
  try {
    const result = await runRoutineNow(clientConfig(env), parsed.id);
    return {
      callId: call.id,
      isError: false,
      content: `Started run ${result.runId}.`,
    };
  } catch (err) {
    return errorResult(call.id, err);
  }
}

const TRIGGER_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["daily"] },
        hour: { type: "number", description: "0-23, in the given timezone." },
        minute: { type: "number", description: "0-59." },
        timezone: {
          type: "string",
          description:
            'IANA timezone, e.g. "America/Los_Angeles". Defaults to UTC.',
        },
      },
      required: ["kind", "hour", "minute"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["weekly"] },
        dayOfWeek: {
          type: "number",
          description: "0 (Sunday) - 6 (Saturday).",
        },
        hour: { type: "number", description: "0-23, in the given timezone." },
        minute: { type: "number", description: "0-59." },
        timezone: {
          type: "string",
          description:
            'IANA timezone, e.g. "America/Los_Angeles". Defaults to UTC.',
        },
      },
      required: ["kind", "dayOfWeek", "hour", "minute"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["cron"] },
        expression: {
          type: "string",
          description:
            "A 5-field cron expression (minute hour day-of-month month day-of-week).",
        },
        timezone: {
          type: "string",
          description: "IANA timezone. Defaults to UTC.",
        },
      },
      required: ["kind", "expression"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["webhook"] },
        webhookTriggerId: {
          type: "string",
          description:
            "The id of an existing webhook trigger this routine fires on.",
        },
      },
      required: ["kind", "webhookTriggerId"],
    },
  ],
} as const;

/**
 * The `@corbits/routines-tools` bundle factory: four tools, three env
 * keys — Myra's own routine-management surface, calling
 * `@corbits/routines`' tenant-scoped, workflow-run-authenticated
 * routine routes and never reimplementing any scheduling, cron, or
 * launch logic of its own.
 */
export const routinesTools = defineTool<WorkflowRoutineEnv>({
  id: "@corbits/routines-tools/routines",
  requires: ["hubRoutinesUrl", "sidecarToken", "address"],
  definitions: [
    { name: ROUTINE_LIST_TOOL },
    { name: ROUTINE_CREATE_TOOL },
    { name: ROUTINE_UPDATE_TOOL },
    { name: ROUTINE_RUN_NOW_TOOL, approval: "ask" },
  ],
  factory: (env) => ({
    definitions: [
      {
        name: ROUTINE_LIST_TOOL,
        description:
          "List the workbench's routines (recurring or triggered " +
          "automations) — name, trigger, target agent, and whether " +
          "each is enabled.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: ROUTINE_CREATE_TOOL,
        description:
          "Create a new routine: a recurring or triggered automation " +
          "that runs an agent definition on a schedule or webhook.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "A short, human-readable name for the routine.",
            },
            definitionId: {
              type: "string",
              description:
                "The id of the agent definition this routine runs — " +
                "never invented; name one already known from a prior " +
                "list_agents or create_agent call.",
            },
            instruction: {
              type: "string",
              description:
                "What to tell the agent to do each time this routine fires.",
            },
            trigger: TRIGGER_SCHEMA,
            enabled: {
              type: "boolean",
              description:
                "Whether the routine starts enabled. Defaults to true.",
            },
          },
          required: ["name", "definitionId", "instruction", "trigger"],
        },
      },
      {
        name: ROUTINE_UPDATE_TOOL,
        description:
          "Update an existing routine's enabled state, name, " +
          "instruction, or trigger.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The routine's id." },
            enabled: {
              type: "boolean",
              description: "Enable or disable the routine.",
            },
            name: {
              type: "string",
              description: "A new name for the routine.",
            },
            instruction: {
              type: "string",
              description:
                "A new instruction to tell the agent each time this routine fires.",
            },
            trigger: TRIGGER_SCHEMA,
          },
          required: ["id"],
        },
      },
      {
        name: ROUTINE_RUN_NOW_TOOL,
        description:
          "Run a routine immediately, outside its schedule. A human " +
          "must approve before it runs.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "The routine's id." },
          },
          required: ["id"],
        },
      },
    ],
    run: (call: ToolCall, _signal: AbortSignal) => {
      switch (call.name) {
        case ROUTINE_LIST_TOOL:
          return runRoutineList(env, call);
        case ROUTINE_CREATE_TOOL:
          return runRoutineCreate(env, call);
        case ROUTINE_UPDATE_TOOL:
          return runRoutineUpdate(env, call);
        case ROUTINE_RUN_NOW_TOOL:
          return runRoutineRunNow(env, call);
        default:
          return Promise.resolve(
            errorResult(
              call.id,
              new Error(`@corbits/routines-tools: unknown tool "${call.name}"`),
            ),
          );
      }
    },
  }),
});
