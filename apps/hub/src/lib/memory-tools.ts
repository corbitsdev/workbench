import type { AgentTool } from "@intx/agent";
import type { DB } from "@intx/db";
import {
  MEMORY_LOAD_DEFINITION,
  MEMORY_SAVE_DEFINITION,
} from "@workbench/tools-artifact";
import { and, desc, eq, sql } from "drizzle-orm";
import { artifact, artifactVersion } from "../db/schema";
import { resolveOwnerMemberPrincipalId } from "./artifact-tools";
import type { ContextToolEntry } from "./tool-registry";

export { MEMORY_LOAD_DEFINITION, MEMORY_SAVE_DEFINITION };

// The artifact kind and title under which a user's durable memory is stored.
// One row per owning member principal — the title is a constant, ownership is
// what scopes it, so a save always targets the caller's own memory.
const MEMORY_KIND = "memory";
const MEMORY_TITLE = "Memory";

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
    .select({ content: artifact.content })
    .from(artifact)
    .where(
      and(
        eq(artifact.tenantId, tenantId),
        eq(artifact.kind, MEMORY_KIND),
        eq(artifact.ownerPrincipalId, ownerPrincipalId),
      ),
    )
    .orderBy(desc(artifact.updatedAt))
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

      // Upsert onto the per-owner partial unique index (artifact_memory_per_owner_uniq,
      // CL-2413): the first save inserts version 1, every later save bumps the
      // version on the same row. Atomic, so two concurrent first-saves converge
      // on one row instead of forking duplicates.
      const version = await context.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(artifact)
          .values({
            tenantId: context.tenantId,
            principalId: context.principalId,
            ownerPrincipalId,
            sessionId: null,
            kind: MEMORY_KIND,
            title: MEMORY_TITLE,
            content,
            source: { type: "memory" },
            status: "draft",
            version: 1,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [artifact.tenantId, artifact.ownerPrincipalId],
            targetWhere: eq(artifact.kind, MEMORY_KIND),
            set: {
              content,
              version: sql`${artifact.version} + 1`,
              updatedAt: now,
            },
          })
          .returning({ id: artifact.id, version: artifact.version });
        if (!row) throw new Error("Failed to save memory");

        await tx.insert(artifactVersion).values({
          artifactId: row.id,
          version: row.version,
          title: MEMORY_TITLE,
          content,
          authorId: context.principalId,
          createdAt: now,
        });
        return row.version;
      });

      return jsonResult({ ok: true, version });
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
