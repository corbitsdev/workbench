import {
  buildRunDetailQuery,
  buildToolCallDetailQuery,
  buildTurnDetailQuery,
  buildTurnPartsQuery,
  MomentDetailSchema,
  type MomentDetail,
  type MomentTurnPart,
} from "@workbench/timeline";
import { type } from "arktype";

import type { HubDb } from "../db";
import { resolveTimelinePrincipalIds } from "./principal-activity";

// postgres-js returns an array-like RowList; PGlite (integration tests) returns
// `{ rows }`. Normalize both, as the timeline union service does.
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }
  return (result as { rows: Record<string, unknown>[] }).rows;
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

// A tool `result` part's content is jsonb — postgres already parses it, but a
// PGlite/text round-trip can hand it back as a JSON string. Normalize so the
// client sees the value, not a re-encoded string.
function normalizeJson(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function toolCallDetail(
  db: HubDb,
  base: { kind: string; id: string },
  scope: { id: string; tenantId: string; principalIds: string[] },
): Promise<MomentDetail | null> {
  const rows = rowsOf(await db.execute(buildToolCallDetailQuery(scope)));
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ...base,
    toolCall: {
      toolName: toStringOrNull(row["tool_name"]),
      input: normalizeJson(row["input"]),
      output: normalizeJson(row["output"]),
      isError: row["is_error"] === true,
    },
  };
}

async function turnDetail(
  db: HubDb,
  base: { kind: string; id: string },
  scope: { id: string; tenantId: string; principalIds: string[] },
): Promise<MomentDetail | null> {
  const rows = rowsOf(await db.execute(buildTurnDetailQuery(scope)));
  const row = rows[0];
  if (row === undefined) return null;
  const partRows = rowsOf(await db.execute(buildTurnPartsQuery(scope.id)));
  const parts: MomentTurnPart[] = partRows.map((part) => {
    const metadata = part["metadata"];
    const meta =
      metadata !== null && typeof metadata === "object"
        ? (metadata as Record<string, unknown>)
        : {};
    const toolName = toStringOrNull(meta["name"]);
    return {
      type: String(part["type"]),
      content: toStringOrNull(part["content"]),
      ...(toolName !== null ? { toolName } : {}),
    };
  });
  return {
    ...base,
    turn: {
      model: toStringOrNull(row["model"]),
      durationMs: toNumberOrNull(row["duration_ms"]),
      parts,
    },
  };
}

async function runDetail(
  db: HubDb,
  base: { kind: string; id: string },
  scope: { id: string; tenantId: string; principalIds: string[] },
): Promise<MomentDetail | null> {
  const rows = rowsOf(await db.execute(buildRunDetailQuery(scope)));
  const row = rows[0];
  if (row === undefined) return null;
  return {
    ...base,
    run: {
      durationMs: toNumberOrNull(row["duration_ms"]),
      outcome: toStringOrNull(row["outcome"]),
    },
  };
}

/**
 * Expand one opened moment into its rich detail. Resolves the same
 * attribution set the timeline union uses, dispatches a per-kind join, and
 * validates the shaped result through the shared boundary schema. Returns
 * `null` when the moment does not resolve within the caller's scope (a
 * cross-principal or non-existent id) — the route maps that to 404.
 */
export async function getMomentDetail(args: {
  db: HubDb;
  tenantId: string;
  principalId: string;
  kind: string;
  id: string;
}): Promise<MomentDetail | null> {
  const principalIds = await resolveTimelinePrincipalIds(args);
  const scope = { id: args.id, tenantId: args.tenantId, principalIds };
  const base = { kind: args.kind, id: args.id };

  let detail: MomentDetail | null;
  if (args.kind === "tool_call") {
    detail = await toolCallDetail(args.db, base, scope);
  } else if (args.kind === "inference_turn") {
    detail = await turnDetail(args.db, base, scope);
  } else if (args.kind === "workflow_run") {
    detail = await runDetail(args.db, base, scope);
  } else {
    // A kind with no detail enrichment has nothing to expand and no scoped
    // existence check we can honor, so 200-echoing the id would imply an
    // unverified moment exists. Resolve to null so the route returns 404
    // (CL-2738), consistent with the documented contract.
    detail = null;
  }

  if (detail === null) return null;

  const parsed = MomentDetailSchema(detail);
  if (parsed instanceof type.errors) {
    throw new Error(
      `Moment detail failed schema validation: ${parsed.summary}`,
    );
  }
  return parsed;
}
