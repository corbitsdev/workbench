import {
  and,
  desc,
  eq,
  ilike,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { type } from "arktype";
import { schema as intxSchema } from "@intx/db";
import {
  PaletteResultItemSchema,
  PaletteSearchResponseSchema,
  type PaletteResultItem,
  type PaletteSearchResponse,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { artifact, memberAgentInstance, workflowRun } from "../db/schema";
import { listAvailableToolSummaries } from "../lib/tenant-tools";

const { agent, agentInstance, asset } = intxSchema;

export const PER_SOURCE_LIMIT = 5;
const MYRA_TEMPLATE_KEY = "myra";
const MAX_QUERY_LENGTH = 200;

// Re-exported under the route's local name; the canonical definition lives in
// @workbench/shared so the web boundary validates the same shape.
export const SearchResponseSchema = PaletteSearchResponseSchema;
export type SearchResponse = PaletteSearchResponse;

export interface SearchParams {
  tenantId: string;
  memberPrincipalId: string;
  query: string;
  page: number;
}

// Escape the LIKE metacharacters a user can type so a literal `%`/`_` is matched
// as itself, not as a wildcard (mirrors the artifacts route).
function escapeLike(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export function humanizeKind(kind: string): string {
  return kind
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) =>
      word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1),
    )
    .join(" ");
}

// Relevance score for in-process catalog matching (tools): exact > prefix >
// contains. Mirrors the SQL CASE rank used for DB-backed sources so every
// source orders the same way.
export function scoreText(query: string, text: string): number {
  const haystack = text.toLowerCase();
  if (haystack === query) return 3;
  if (haystack.startsWith(query)) return 2;
  if (haystack.includes(query)) return 1;
  return 0;
}

// SQL relevance rank for a column against the (already lowercased) query: 3 for
// an exact match, 2 for a prefix match, 1 otherwise. The WHERE clause has
// already constrained rows to a `%query%` contains-match, so the floor is 1.
function rankColumn(
  column: Parameters<typeof ilike>[0],
  query: string,
  likePrefix: string,
) {
  return sql<number>`CASE WHEN lower(${column}) = ${query} THEN 3 WHEN ${column} ILIKE ${likePrefix} THEN 2 ELSE 1 END`;
}

interface SourcePage<T> {
  rows: T[];
  hasMore: boolean;
}

export function paginate<T>(rows: T[]): SourcePage<T> {
  const hasMore = rows.length > PER_SOURCE_LIMIT;
  return { rows: hasMore ? rows.slice(0, PER_SOURCE_LIMIT) : rows, hasMore };
}

/**
 * Tenant-scoped aggregate search across every workbench source (chats,
 * workflows, agents, artifacts, skills, tools). Every DB query carries a
 * `tenant_id = ?` predicate — cross-tenant rows can never appear in the result.
 * Each source returns at most {@link PER_SOURCE_LIMIT} rows at `OFFSET page*5`
 * so the client's "load more" fetches the next slice of each. Results are
 * normalized to the shared {@link PaletteResultItemSchema} shape and validated
 * at the boundary before return.
 */
export async function searchTenant(
  db: HubDb,
  params: SearchParams,
): Promise<SearchResponse> {
  const query = params.query.trim().slice(0, MAX_QUERY_LENGTH).toLowerCase();
  const page =
    Number.isFinite(params.page) && params.page > 0
      ? Math.floor(params.page)
      : 0;
  if (query === "") return { results: [], page, hasMore: false };

  const like = `%${escapeLike(query)}%`;
  const prefix = `${escapeLike(query)}%`;
  const offset = page * PER_SOURCE_LIMIT;
  const fetchLimit = PER_SOURCE_LIMIT + 1;

  const chats = paginate(
    await db
      .select({
        id: memberAgentInstance.id,
        label: memberAgentInstance.label,
        createdAt: memberAgentInstance.createdAt,
      })
      .from(memberAgentInstance)
      .where(
        and(
          eq(memberAgentInstance.tenantId, params.tenantId),
          eq(memberAgentInstance.memberPrincipalId, params.memberPrincipalId),
          eq(memberAgentInstance.templateKey, MYRA_TEMPLATE_KEY),
          ilike(memberAgentInstance.label, like),
        ),
      )
      .orderBy(
        desc(rankColumn(memberAgentInstance.label, query, prefix)),
        desc(memberAgentInstance.createdAt),
      )
      .limit(fetchLimit)
      .offset(offset),
  );

  const workflows = paginate(
    await db
      .select({
        kind: workflowRun.kind,
        updatedAt: sql<Date>`max(${workflowRun.updatedAt})`,
      })
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.tenantId, params.tenantId),
          isNull(workflowRun.deletedAt),
          ilike(workflowRun.kind, like),
        ),
      )
      .groupBy(workflowRun.kind)
      .orderBy(
        desc(rankColumn(workflowRun.kind, query, prefix)),
        desc(sql`max(${workflowRun.updatedAt})`),
      )
      .limit(fetchLimit)
      .offset(offset),
  );

  const memberInstanceRows = await db
    .select({ instanceId: memberAgentInstance.instanceId })
    .from(memberAgentInstance)
    .where(eq(memberAgentInstance.tenantId, params.tenantId));
  const memberInstanceIds = memberInstanceRows.map((r) => r.instanceId);

  const agents = paginate(
    await db
      .select({
        id: agentInstance.id,
        name: agent.name,
        status: agentInstance.status,
        updatedAt: agentInstance.updatedAt,
      })
      .from(agentInstance)
      .innerJoin(agent, eq(agentInstance.agentId, agent.id))
      .where(
        and(
          eq(agentInstance.tenantId, params.tenantId),
          ilike(agent.name, like),
          memberInstanceIds.length > 0
            ? notInArray(agentInstance.id, memberInstanceIds)
            : undefined,
        ),
      )
      .orderBy(
        desc(rankColumn(agent.name, query, prefix)),
        desc(agentInstance.updatedAt),
      )
      .limit(fetchLimit)
      .offset(offset),
  );

  const artifacts = paginate(
    await db
      .select({
        id: artifact.id,
        title: artifact.title,
        updatedAt: artifact.updatedAt,
      })
      .from(artifact)
      .where(
        and(
          eq(artifact.tenantId, params.tenantId),
          ne(artifact.status, "rejected"),
          isNull(artifact.archivedAt),
          ilike(artifact.title, like),
        ),
      )
      .orderBy(
        desc(rankColumn(artifact.title, query, prefix)),
        desc(artifact.updatedAt),
      )
      .limit(fetchLimit)
      .offset(offset),
  );

  const skills = paginate(
    await db
      .select({
        id: asset.id,
        name: asset.name,
        displayName: asset.displayName,
        updatedAt: asset.updatedAt,
      })
      .from(asset)
      .where(
        and(
          eq(asset.tenantId, params.tenantId),
          eq(asset.kind, "skill"),
          or(ilike(asset.name, like), ilike(asset.displayName, like)),
        ),
      )
      .orderBy(
        desc(rankColumn(asset.name, query, prefix)),
        desc(asset.updatedAt),
      )
      .limit(fetchLimit)
      .offset(offset),
  );

  const allTools = await listAvailableToolSummaries(db, params.tenantId);
  const matchedTools = allTools
    .map((tool) => ({
      tool,
      score: Math.max(
        scoreText(query, tool.name),
        scoreText(query, tool.description),
      ),
    }))
    .filter((t) => t.score > 0)
    .sort(
      (a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name),
    );
  const toolSlice = matchedTools.slice(offset, offset + PER_SOURCE_LIMIT);
  const toolsHasMore = matchedTools.length > offset + PER_SOURCE_LIMIT;

  const results: PaletteResultItem[] = [
    ...chats.rows.map((row) => ({
      id: `conversation:${row.id}`,
      category: "conversation" as const,
      title: row.label?.trim() || "Chat",
      to: `/chats/${row.id}`,
    })),
    ...agents.rows.map((row) => ({
      id: `agent:${row.id}`,
      category: "agent" as const,
      title: row.name,
      subtitle: row.status,
      to: "/chats",
    })),
    ...workflows.rows.map((row) => ({
      id: `workflow:${row.kind}`,
      category: "workflow" as const,
      title: humanizeKind(row.kind),
      to: "/workflows",
      keywords: [row.kind],
    })),
    ...artifacts.rows.map((row) => ({
      id: `artifact:${row.id}`,
      category: "artifact" as const,
      title: row.title,
      to: `/artifacts/${row.id}`,
    })),
    ...skills.rows.map((row) => ({
      id: `skill:${row.id}`,
      category: "skill" as const,
      title: row.displayName?.trim() || row.name,
      to: `/skills/${row.id}`,
    })),
    ...toolSlice.map(({ tool }) => ({
      id: `tool:${tool.name}`,
      category: "tool" as const,
      title: tool.name,
      subtitle: tool.providerName,
      to: `/tools/${encodeURIComponent(tool.name)}`,
    })),
  ];

  const validated = PaletteResultItemSchema.array()(results);
  if (validated instanceof type.errors) {
    throw new Error(`Invalid search result shape: ${validated.summary}`);
  }

  const hasMore =
    chats.hasMore ||
    workflows.hasMore ||
    agents.hasMore ||
    artifacts.hasMore ||
    skills.hasMore ||
    toolsHasMore;

  return { results: validated, page, hasMore };
}
