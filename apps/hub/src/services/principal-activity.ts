import { schema as intxSchema } from "@intx/db";
import {
  buildTimelineUnionQuery,
  TimelineEntrySchema,
  type TimelineCursor,
  type TimelineEntry,
} from "@workbench/timeline";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";

import type { HubDb } from "../db";
import { memberAgentInstance } from "../db/schema";

export type PrincipalActivityPage = {
  entries: TimelineEntry[];
  nextCursor: TimelineCursor | null;
};

function toIsoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Timeline row carried an unreadable timestamp: ${String(value)}`,
    );
  }
  return date.toISOString();
}

// Session, mail, inference-turn, and tool-call rows attribute to the agent
// INSTANCE's synthetic principal (provisioning launches instances under their
// own principal), not the owning user's member principal. The workbench-owned
// member_agent_instance link maps user -> owned instances; joining through
// agent_instance recovers each instance's synthetic principal. Tenant-pinned
// on both sides so an instance id reused in another tenant cannot bleed
// attribution across the boundary.
export async function resolveTimelinePrincipalIds(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
}): Promise<string[]> {
  const rows = await args.db
    .select({ principalId: intxSchema.agentInstance.principalId })
    .from(memberAgentInstance)
    .innerJoin(
      intxSchema.agentInstance,
      and(
        eq(intxSchema.agentInstance.id, memberAgentInstance.instanceId),
        eq(intxSchema.agentInstance.tenantId, memberAgentInstance.tenantId),
      ),
    )
    .where(
      and(
        eq(memberAgentInstance.tenantId, args.tenantId),
        eq(memberAgentInstance.memberPrincipalId, args.principalId),
      ),
    );
  return [
    ...new Set<string>([args.principalId, ...rows.map((r) => r.principalId)]),
  ];
}

// Thin execution over @workbench/timeline: resolve the queried principal's
// attribution set, run the descriptor-generated union with keyset pagination,
// and validate every row through the package's entry schema at the boundary.
// The next cursor carries the boundary row's timestamp as the verbatim
// Postgres text (`ts_text`) — never a JS Date reformat, which truncates
// microseconds and drops rows at a sub-millisecond page boundary.
export async function getPrincipalActivityPage(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
  limit: number;
  cursor?: TimelineCursor;
}): Promise<PrincipalActivityPage> {
  const principalIds = await resolveTimelinePrincipalIds(args);
  const query = buildTimelineUnionQuery({
    scope: { tenantId: args.tenantId, principalIds },
    limit: args.limit,
    ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
  });

  // postgres-js returns an array-like RowList; PGlite (integration tests)
  // returns `{ rows }` — normalize both.
  const result: unknown = await args.db.execute(query);
  const rows = Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : (result as { rows: Record<string, unknown>[] }).rows;
  const entries = rows.map((row) => {
    const candidate = {
      id: row["id"],
      kind: row["kind"],
      sourceTable: row["source_table"],
      timestamp: toIsoTimestamp(row["ts"]),
      summary: row["summary"] ?? null,
    };
    const parsed = TimelineEntrySchema(candidate);
    if (parsed instanceof type.errors) {
      throw new Error(
        `Timeline row failed entry validation: ${parsed.summary}`,
      );
    }
    return parsed;
  });

  const lastRow = rows[rows.length - 1];
  const lastEntry = entries[entries.length - 1];
  let nextCursor: TimelineCursor | null = null;
  if (
    entries.length === args.limit &&
    lastRow !== undefined &&
    lastEntry !== undefined
  ) {
    const tsText = lastRow["ts_text"];
    if (typeof tsText !== "string" || tsText === "") {
      throw new Error("Timeline row is missing its lossless ts_text column");
    }
    nextCursor = {
      timestamp: tsText,
      sourceTable: lastEntry.sourceTable,
      id: lastEntry.id,
    };
  }

  return { entries, nextCursor };
}
