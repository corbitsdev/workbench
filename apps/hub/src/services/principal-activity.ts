import { type } from "arktype";
import {
  buildTimelineUnionQuery,
  decodeTimelineCursor,
  encodeTimelineCursor,
  TimelineEntrySchema,
  type TimelineEntry,
} from "@workbench/timeline";

import type { HubDb } from "../db";

export type PrincipalActivityPage = {
  entries: TimelineEntry[];
  nextCursor: string | null;
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

// Thin execution over @workbench/timeline: run the descriptor-generated union
// with keyset pagination and validate every row through the package's entry
// schema at the boundary. All domain knowledge (sources, scoping, ordering)
// stays in the package.
export async function getPrincipalActivityPage(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
  limit: number;
  cursor?: string;
}): Promise<PrincipalActivityPage> {
  const cursor =
    args.cursor !== undefined ? decodeTimelineCursor(args.cursor) : undefined;
  const query = buildTimelineUnionQuery({
    scope: { tenantId: args.tenantId, principalId: args.principalId },
    limit: args.limit,
    ...(cursor !== undefined ? { cursor } : {}),
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

  const last = entries[entries.length - 1];
  const nextCursor =
    entries.length === args.limit && last !== undefined
      ? encodeTimelineCursor({
          timestamp: last.timestamp,
          sourceTable: last.sourceTable,
          id: last.id,
        })
      : null;

  return { entries, nextCursor };
}
