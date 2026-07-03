import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import {
  MEMORY_LOAD_DEFINITION,
  MEMORY_SAVE_DEFINITION,
} from "@workbench/tools-artifact";
import { and, eq } from "drizzle-orm";
import { memory } from "../db/schema";
import { resolveOwnerMemberPrincipalId } from "./artifact-tools";
import type { ContextToolEntry } from "./tool-registry";

export { MEMORY_LOAD_DEFINITION, MEMORY_SAVE_DEFINITION };

type MemoryToolContext = {
  db: DB["db"];
  tenantId: string;
  principalId: string;
};

type MemoryScope = "global" | "chat";

function jsonResult(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// Only 'global' is wired. 'chat' (per-conversation) memory is deliberately
// deferred — the tool accepts the axis so the contract is stable, but returns a
// clear deferred marker instead of silently treating chat writes as global.
function parseScope(args: Record<string, unknown>): MemoryScope | "deferred" {
  const raw = args.scope;
  if (raw === undefined || raw === "global") return "global";
  if (typeof raw !== "string") {
    throw new Error("scope must be a string");
  }
  if (raw === "chat") return "deferred";
  throw new Error(`scope must be one of: global, chat`);
}

function requiredContent(args: Record<string, unknown>): string {
  const value = args.content;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("content is required");
  }
  return value;
}

const CHAT_DEFERRED = jsonResult({
  ok: false,
  reason: "chat-scoped memory is not enabled yet; use scope 'global'.",
});

async function loadOwnerMemoryContent(
  db: DB["db"],
  tenantId: string,
  ownerPrincipalId: string,
): Promise<string> {
  const [row] = await db
    .select({ content: memory.content })
    .from(memory)
    .where(
      and(
        eq(memory.tenantId, tenantId),
        eq(memory.ownerPrincipalId, ownerPrincipalId),
      ),
    )
    .limit(1);
  return row?.content ?? "";
}

function createLoadHandler(context: MemoryToolContext): AgentTool {
  return {
    kind: "string",
    definition: MEMORY_LOAD_DEFINITION,
    handler: async (args) => {
      if (parseScope(args) === "deferred") return CHAT_DEFERRED;

      const ownerPrincipalId = await resolveOwnerMemberPrincipalId(
        context.db,
        context,
      );
      // No owning member → no memory to load. Return empty rather than failing:
      // a fresh agent with nothing stored yet is a normal state, and there is
      // no other principal's memory to leak because the owner is resolved from
      // the caller's own context.
      if (ownerPrincipalId === null) {
        return jsonResult({ content: "" });
      }

      const content = await loadOwnerMemoryContent(
        context.db,
        context.tenantId,
        ownerPrincipalId,
      );
      return jsonResult({ content });
    },
  };
}

function createSaveHandler(context: MemoryToolContext): AgentTool {
  return {
    kind: "string",
    definition: MEMORY_SAVE_DEFINITION,
    handler: async (args) => {
      if (parseScope(args) === "deferred") return CHAT_DEFERRED;
      const content = requiredContent(args);

      const ownerPrincipalId = await resolveOwnerMemberPrincipalId(
        context.db,
        context,
      );
      // Fail closed: without an owning member there is nowhere user-scoped to
      // persist, and writing an unowned memory row would orphan it. Surface the
      // misconfiguration loudly instead of silently dropping the write.
      if (ownerPrincipalId === null) {
        throw new Error(
          "Cannot save memory: this agent has no owning user to scope it to",
        );
      }

      const now = new Date();

      // Upsert onto the (tenantId, ownerPrincipalId) unique index (CL-2668):
      // the first save inserts a row, every later save overwrites its content.
      // Atomic, so two concurrent first-saves converge on one row instead of
      // forking duplicates.
      await context.db
        .insert(memory)
        .values({
          tenantId: context.tenantId,
          ownerPrincipalId,
          content,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [memory.tenantId, memory.ownerPrincipalId],
          set: { content, updatedAt: now },
        });

      return jsonResult({ ok: true });
    },
  };
}

export function createMemoryTools(context: MemoryToolContext): AgentTool[] {
  return [createLoadHandler(context), createSaveHandler(context)];
}

export const MEMORY_HUB_TOOLS: Record<string, ContextToolEntry> = {
  memory_load: {
    definition: MEMORY_LOAD_DEFINITION,
    createTools: (ctx) =>
      createMemoryTools({
        db: ctx.db,
        tenantId: ctx.tenantId,
        principalId: ctx.principalId,
      }),
  },
  memory_save: {
    definition: MEMORY_SAVE_DEFINITION,
    createTools: (ctx) =>
      createMemoryTools({
        db: ctx.db,
        tenantId: ctx.tenantId,
        principalId: ctx.principalId,
      }),
  },
};
