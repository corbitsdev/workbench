import type { AgentTool } from "@intx/agent";
import type { ToolDefinition } from "@intx/types/runtime";
import { type } from "arktype";
import {
  taskStatuses,
  TaskLinkSchema,
  type TaskStatus,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { resolveOwnerMemberPrincipalId } from "../lib/artifact-tools";
import {
  createOwnerTask,
  listOwnerTasks,
  resolveTriageTaskDefaultStatus,
  updateOwnerTask,
} from "../lib/task-store";
import type { ContextToolEntry } from "../lib/tool-registry";

// Hub-backed context tools that let an agent (e.g. the triage Myra) leave a
// durable native task behind. Owner is resolved from the agent's owning member
// — never from a tool argument — so an agent can only create/read/update tasks
// for the user it belongs to.

type TaskToolContext = {
  db: HubDb;
  tenantId: string;
  principalId: string;
};

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const CreateArgs = type({
  title: "string > 0",
  "body?": "string",
  "due?": "string",
  "sourceRef?": "string",
  "links?": TaskLinkSchema.array(),
});

const UpdateArgs = type({
  taskId: "string.uuid",
  "title?": "string > 0",
  "body?": "string",
  "status?": type.enumerated(...taskStatuses),
  "due?": "string | null",
});

const ListArgs = type({
  "status?": type.enumerated(...taskStatuses),
  "limit?": "number.integer > 0",
});

export const TASK_CREATE_DEFINITION: ToolDefinition = {
  name: "task_create",
  description:
    "Create a native Workbench task for the user you are working on behalf of — durable work to leave behind (e.g. a follow-up you prepared). Pass a short `title` and optional `body`, `due` (ISO 8601), and `links`. The task is owned by your user automatically.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short imperative title." },
      body: { type: "string", description: "Optional detail / context." },
      due: { type: "string", description: "Optional due date (ISO 8601)." },
      links: {
        type: "array",
        description:
          "Optional links back to the originating object (artifact, workflow run, mail, conversation, or url).",
      },
    },
    required: ["title"],
  },
};

export const TASK_UPDATE_DEFINITION: ToolDefinition = {
  name: "task_update",
  description:
    "Update one of your user's tasks by id — change its `title`, `body`, `status` (open/in_progress/waiting/done/cancelled), or `due`. Only tasks owned by your user can be updated.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "The task id to update." },
      title: { type: "string" },
      body: { type: "string" },
      status: {
        type: "string",
        description:
          "New status: open, in_progress, waiting, done, or cancelled.",
      },
      due: { type: "string", description: "New due date (ISO 8601) or null." },
    },
    required: ["taskId"],
  },
};

export const TASK_LIST_DEFINITION: ToolDefinition = {
  name: "task_list",
  description:
    "List your user's tasks, newest first. Optionally filter by `status` and cap with `limit`. Returns only tasks owned by your user.",
  inputSchema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        description:
          "Optional status filter: open, in_progress, waiting, done, or cancelled.",
      },
      limit: { type: "number", description: "Maximum tasks to return." },
    },
  },
};

async function requireOwner(context: TaskToolContext): Promise<string> {
  const owner = await resolveOwnerMemberPrincipalId(context.db, {
    tenantId: context.tenantId,
    principalId: context.principalId,
  });
  if (owner === null) {
    throw new Error(
      "Cannot manage tasks: this agent has no owning user to scope them to",
    );
  }
  return owner;
}

function createTaskCreateTool(context: TaskToolContext): AgentTool {
  return {
    kind: "string",
    definition: TASK_CREATE_DEFINITION,
    handler: async (args) => {
      const parsed = CreateArgs(args);
      if (parsed instanceof type.errors) {
        throw new Error(`task_create: ${parsed.summary}`);
      }
      const owner = await requireOwner(context);
      const defaultStatus = await resolveTriageTaskDefaultStatus(context.db, {
        tenantId: context.tenantId,
        principalId: context.principalId,
      });
      const created = await createOwnerTask(context.db, {
        tenantId: context.tenantId,
        ownerPrincipalId: owner,
        createdByPrincipalId: context.principalId,
        title: parsed.title,
        source: "agent",
        ...(defaultStatus !== undefined ? { status: defaultStatus } : {}),
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        ...(parsed.due !== undefined ? { due: parsed.due } : {}),
        ...(parsed.sourceRef !== undefined
          ? { sourceRef: parsed.sourceRef }
          : {}),
        ...(parsed.links !== undefined ? { links: parsed.links } : {}),
      });
      return jsonResult(created);
    },
  };
}

function createTaskUpdateTool(context: TaskToolContext): AgentTool {
  return {
    kind: "string",
    definition: TASK_UPDATE_DEFINITION,
    handler: async (args) => {
      const parsed = UpdateArgs(args);
      if (parsed instanceof type.errors) {
        throw new Error(`task_update: ${parsed.summary}`);
      }
      const owner = await requireOwner(context);
      const updated = await updateOwnerTask(context.db, {
        tenantId: context.tenantId,
        ownerPrincipalId: owner,
        actorPrincipalId: context.principalId,
        id: parsed.taskId,
        ...(parsed.title !== undefined ? { title: parsed.title } : {}),
        ...(parsed.body !== undefined ? { body: parsed.body } : {}),
        ...(parsed.status !== undefined
          ? { status: parsed.status as TaskStatus }
          : {}),
        ...(parsed.due !== undefined ? { due: parsed.due } : {}),
      });
      if (updated === null) {
        throw new Error(`task_update: no task ${parsed.taskId} owned by you`);
      }
      return jsonResult(updated);
    },
  };
}

function createTaskListTool(context: TaskToolContext): AgentTool {
  return {
    kind: "string",
    definition: TASK_LIST_DEFINITION,
    handler: async (args) => {
      const parsed = ListArgs(args);
      if (parsed instanceof type.errors) {
        throw new Error(`task_list: ${parsed.summary}`);
      }
      const owner = await resolveOwnerMemberPrincipalId(context.db, {
        tenantId: context.tenantId,
        principalId: context.principalId,
      });
      if (owner === null) return jsonResult({ tasks: [] });
      const { items: tasks } = await listOwnerTasks(context.db, {
        tenantId: context.tenantId,
        ownerPrincipalId: owner,
        ...(parsed.status !== undefined
          ? { statuses: [parsed.status as TaskStatus] }
          : {}),
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      });
      return jsonResult({ tasks });
    },
  };
}

export function createTaskTools(context: TaskToolContext): AgentTool[] {
  return [
    createTaskCreateTool(context),
    createTaskUpdateTool(context),
    createTaskListTool(context),
  ];
}

function toContext(ctx: {
  db: HubDb;
  tenantId: string;
  principalId: string;
}): TaskToolContext {
  return {
    db: ctx.db,
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
  };
}

export const TASK_HUB_TOOLS: Record<string, ContextToolEntry> = {
  task_create: {
    sideEffect: "write",
    definition: TASK_CREATE_DEFINITION,
    createTools: (ctx) => [createTaskCreateTool(toContext(ctx))],
  },
  task_update: {
    sideEffect: "write",
    definition: TASK_UPDATE_DEFINITION,
    createTools: (ctx) => [createTaskUpdateTool(toContext(ctx))],
  },
  task_list: {
    sideEffect: "read",
    definition: TASK_LIST_DEFINITION,
    createTools: (ctx) => [createTaskListTool(toContext(ctx))],
  },
};
