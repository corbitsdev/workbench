import type { AgentTool } from "@intx/agent";
import { getLogger } from "@intx/log";
import type { ToolDefinition } from "@intx/types/runtime";
import {
  CallAnalysisSchema,
  GranolaCallSchema,
  granolaTaskSourceRef,
  type CallAction,
  type CallAnalysis,
  type TaskLink,
} from "@workbench/shared";
import { type } from "arktype";
import type { HubDb } from "../db";
import { createOwnerTask, findOwnerTaskBySourceRef } from "../lib/task-store";
import type { ContextToolEntry } from "../lib/tool-registry";
import {
  listMyraMembers,
  matchParticipantsToMembers,
  type GranolaCallFanout,
} from "../services/granola-call-fanout";

const log = getLogger(["tools", "granola-call-tools"]);

// Fan-out needs grantStore + mailboxEventBus which ContextToolEntry cannot
// supply. index.ts injects the already-wired fanout service once at boot.
type GranolaCallToolDeps = {
  fanout: GranolaCallFanout;
};

let toolDeps: GranolaCallToolDeps | null = null;

/** Wire hub services the Granola call tools cannot construct themselves. */
export function setGranolaCallToolDeps(deps: GranolaCallToolDeps): void {
  toolDeps = deps;
}

function requireFanout(): GranolaCallFanout {
  if (toolDeps === null) {
    throw new Error(
      "granola call tools: fanout not configured (setGranolaCallToolDeps missing)",
    );
  }
  return toolDeps.fanout;
}

type ToolContext = {
  db: HubDb;
  tenantId: string;
  principalId: string;
};

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const CreateTasksArgs = type({
  noteId: "string > 0",
  "ownerPrincipalId?": "string > 0",
  analysis: "unknown",
  "briefArtifactId?": "string > 0",
  "summaryArtifactId?": "string > 0",
  "painArtifactId?": "string > 0",
});

const FanoutCallArgs = type({
  note: GranolaCallSchema,
  classification: "'internal' | 'external' | 'unknown'",
  analysis: CallAnalysisSchema,
  artifactId: "string > 0",
});

export const GRANOLA_CREATE_TASKS_DEFINITION: ToolDefinition = {
  name: "granola_create_tasks",
  description:
    "Create native Workbench tasks for Granola call follow-ups. Combines analysis.tasks and analysis.actionItems (in that order), matches each assignee to a tenant Myra member when possible (email first, then unambiguous name), and falls back to the calling principal (or optional ownerPrincipalId). Idempotent via sourceRef per (note, index). Links each task to the call artifacts when available.",
  inputSchema: {
    type: "object",
    properties: {
      noteId: {
        type: "string",
        description: "Granola note id (stable key for task sourceRef).",
      },
      analysis: {
        description:
          "Call analysis object (or JSON string) with tasks and actionItems.",
      },
      ownerPrincipalId: {
        type: "string",
        description:
          "Optional default owner principal id. Defaults to the calling principal.",
      },
      briefArtifactId: {
        type: "string",
        description: "Optional brief artifact id to link on each task.",
      },
      summaryArtifactId: {
        type: "string",
        description: "Optional summary artifact id to link on each task.",
      },
      painArtifactId: {
        type: "string",
        description: "Optional pain-points artifact id to link on each task.",
      },
    },
    required: ["noteId", "analysis"],
  },
};

export const GRANOLA_FANOUT_CALL_DEFINITION: ToolDefinition = {
  name: "granola_fanout_call",
  description:
    "Fan a processed Granola call out to matched tenant members (participants + people mentioned who have Granola enabled). Delivers one deduped mail per (call, recipient) with the summary, artifact reference, and that recipient's action items.",
  inputSchema: {
    type: "object",
    properties: {
      note: {
        type: "object",
        description: "Granola call note (id, title, participants, …).",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          participants: {
            type: "array",
            items: { type: "string" },
          },
          createdAt: { type: "string" },
          transcript: { type: "string" },
        },
        required: ["id"],
      },
      classification: {
        type: "string",
        description: "internal | external | unknown",
      },
      analysis: {
        type: "object",
        description:
          "Validated call analysis (summary, tasks, actionItems, …).",
      },
      artifactId: {
        type: "string",
        description: "Persisted call artifact id to reference in mail.",
      },
    },
    required: ["note", "classification", "analysis", "artifactId"],
  },
};

export type CreateTasksResult = {
  created: number;
  skipped: number;
  taskIds: string[];
};

function parseAnalysis(value: unknown): CallAnalysis {
  let raw: unknown = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      throw new Error("granola_create_tasks: analysis is not valid JSON");
    }
  }
  const analysis = CallAnalysisSchema(raw);
  if (analysis instanceof type.errors) {
    throw new Error(`granola_create_tasks: analysis ${analysis.summary}`);
  }
  return analysis;
}

function buildTaskLinks(args: {
  briefArtifactId?: string;
  summaryArtifactId?: string;
  painArtifactId?: string;
}): TaskLink[] {
  const links: TaskLink[] = [];
  if (args.briefArtifactId) {
    links.push({
      kind: "artifact",
      ref: args.briefArtifactId,
      label: "Call brief",
    });
  }
  if (args.summaryArtifactId) {
    links.push({
      kind: "artifact",
      ref: args.summaryArtifactId,
      label: "Call summary",
    });
  }
  if (args.painArtifactId) {
    links.push({
      kind: "artifact",
      ref: args.painArtifactId,
      label: "Pain points",
    });
  }
  return links;
}

/**
 * Combine tasks + actionItems; for each item, resolve an owner (assignee match
 * when possible, else defaultOwner) and create an owner task (deduped by
 * sourceRef) with artifact links when provided.
 */
export async function createTasks(
  context: ToolContext,
  args: {
    noteId: string;
    analysis: CallAnalysis;
    ownerPrincipalId?: string;
    briefArtifactId?: string;
    summaryArtifactId?: string;
    painArtifactId?: string;
  },
): Promise<CreateTasksResult> {
  const items: CallAction[] = [
    ...args.analysis.tasks,
    ...args.analysis.actionItems,
  ];
  const defaultOwner = args.ownerPrincipalId ?? context.principalId;
  const members = await listMyraMembers(context.db, context.tenantId);
  const links = buildTaskLinks(args);

  let created = 0;
  let skipped = 0;
  const taskIds: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item === undefined) continue;

    let ownerPrincipalId = defaultOwner;
    if (item.assignee !== undefined && item.assignee.trim() !== "") {
      const { matched } = matchParticipantsToMembers([item.assignee], members);
      if (matched.length === 1 && matched[0] !== undefined) {
        ownerPrincipalId = matched[0].principalId;
      }
    }

    const sourceRef = granolaTaskSourceRef(args.noteId, i);
    const existing = await findOwnerTaskBySourceRef(context.db, {
      tenantId: context.tenantId,
      ownerPrincipalId,
      sourceRef,
    });
    if (existing !== null) {
      skipped += 1;
      taskIds.push(existing.id);
      log.info("granola create tasks: sourceRef already exists; skipping", {
        noteId: args.noteId,
        index: i,
        sourceRef,
        taskId: existing.id,
      });
      continue;
    }

    const task = await createOwnerTask(context.db, {
      tenantId: context.tenantId,
      ownerPrincipalId,
      createdByPrincipalId: context.principalId,
      title: item.description,
      source: "agent",
      sourceRef,
      ...(links.length > 0 ? { links } : {}),
    });
    created += 1;
    taskIds.push(task.id);
  }

  return { created, skipped, taskIds };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stepContent(args: Record<string, unknown>, key: string): unknown {
  const step = asRecord(parseMaybeJson(args[key]));
  if (!step) return undefined;
  return parseMaybeJson(step.content) ?? step;
}

function readArtifactIdFromStep(
  args: Record<string, unknown>,
  stepKey: string,
): string | undefined {
  const step = asRecord(stepContent(args, stepKey));
  if (!step) return undefined;
  for (const key of ["artifactId", "id"]) {
    const v = step[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

function resolveCreateTasksArgs(args: Record<string, unknown>): {
  noteId: string;
  analysis: unknown;
  ownerPrincipalId?: string;
  briefArtifactId?: string;
  summaryArtifactId?: string;
  painArtifactId?: string;
} {
  const prepare = asRecord(stepContent(args, "prepare"));
  const parse = stepContent(args, "parse");
  const noteId =
    (typeof args.noteId === "string" && args.noteId) ||
    (typeof prepare?.noteId === "string" ? prepare.noteId : "") ||
    "";
  const analysis = args.analysis ?? parse ?? prepare?.analysis ?? prepare;
  const ownerPrincipalId =
    typeof args.ownerPrincipalId === "string"
      ? args.ownerPrincipalId
      : undefined;
  const briefArtifactId =
    (typeof args.briefArtifactId === "string" && args.briefArtifactId) ||
    readArtifactIdFromStep(args, "persist-brief");
  const summaryArtifactId =
    (typeof args.summaryArtifactId === "string" && args.summaryArtifactId) ||
    readArtifactIdFromStep(args, "persist-summary");
  const painArtifactId =
    (typeof args.painArtifactId === "string" && args.painArtifactId) ||
    readArtifactIdFromStep(args, "persist-pain");
  return {
    noteId,
    analysis,
    ...(ownerPrincipalId !== undefined ? { ownerPrincipalId } : {}),
    ...(briefArtifactId !== undefined ? { briefArtifactId } : {}),
    ...(summaryArtifactId !== undefined ? { summaryArtifactId } : {}),
    ...(painArtifactId !== undefined ? { painArtifactId } : {}),
  };
}

function resolveFanoutArgs(args: Record<string, unknown>): {
  note: unknown;
  classification: unknown;
  analysis: unknown;
  artifactId: string;
} {
  const prepare = asRecord(stepContent(args, "prepare"));
  const brief = asRecord(stepContent(args, "persist-brief"));
  const note = args.note ?? prepare?.note ?? prepare;
  const classification = args.classification ?? prepare?.classification;
  const analysis = args.analysis ?? prepare?.analysis;
  const artifactId =
    (typeof args.artifactId === "string" && args.artifactId) ||
    (typeof brief?.artifactId === "string" ? brief.artifactId : "") ||
    "";
  return { note, classification, analysis, artifactId };
}

function createCreateTasksTool(context: ToolContext): AgentTool {
  return {
    kind: "string",
    definition: GRANOLA_CREATE_TASKS_DEFINITION,
    handler: async (args) => {
      const resolved = resolveCreateTasksArgs(args as Record<string, unknown>);
      const parsed = CreateTasksArgs(resolved);
      if (parsed instanceof type.errors) {
        throw new Error(`granola_create_tasks: ${parsed.summary}`);
      }
      const analysis = parseAnalysis(parsed.analysis);
      const result = await createTasks(context, {
        noteId: parsed.noteId,
        analysis,
        ...(parsed.ownerPrincipalId !== undefined
          ? { ownerPrincipalId: parsed.ownerPrincipalId }
          : {}),
        ...(parsed.briefArtifactId !== undefined
          ? { briefArtifactId: parsed.briefArtifactId }
          : {}),
        ...(parsed.summaryArtifactId !== undefined
          ? { summaryArtifactId: parsed.summaryArtifactId }
          : {}),
        ...(parsed.painArtifactId !== undefined
          ? { painArtifactId: parsed.painArtifactId }
          : {}),
      });
      return jsonResult(result);
    },
  };
}

function createFanoutCallTool(context: ToolContext): AgentTool {
  return {
    kind: "string",
    definition: GRANOLA_FANOUT_CALL_DEFINITION,
    handler: async (args) => {
      const resolved = resolveFanoutArgs(args as Record<string, unknown>);
      const parsed = FanoutCallArgs(resolved);
      if (parsed instanceof type.errors) {
        throw new Error(`granola_fanout_call: ${parsed.summary}`);
      }
      const fanout = requireFanout();
      const result = await fanout.fanOut({
        tenantId: context.tenantId,
        note: parsed.note,
        classification: parsed.classification,
        analysis: parsed.analysis,
        artifactId: parsed.artifactId,
      });
      return jsonResult(result);
    },
  };
}

function toContext(ctx: {
  db: HubDb;
  tenantId: string;
  principalId: string;
}): ToolContext {
  return {
    db: ctx.db,
    tenantId: ctx.tenantId,
    principalId: ctx.principalId,
  };
}

export const GRANOLA_CALL_HUB_TOOLS: Record<string, ContextToolEntry> = {
  granola_create_tasks: {
    sideEffect: "write",
    definition: GRANOLA_CREATE_TASKS_DEFINITION,
    createTools: (ctx) => [createCreateTasksTool(toContext(ctx))],
  },
  granola_fanout_call: {
    sideEffect: "write",
    definition: GRANOLA_FANOUT_CALL_DEFINITION,
    createTools: (ctx) => [createFanoutCallTool(toContext(ctx))],
  },
};
