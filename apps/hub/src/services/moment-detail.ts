import {
  buildRunDetailQuery,
  buildToolCallDetailQuery,
  buildTurnDetailQuery,
  buildTurnPartsQuery,
  MomentDetailSchema,
  type MomentDetail,
  type MomentTurnPart,
  type MomentTurnInputMessage,
} from "@workbench/timeline";
import { type } from "arktype";
import { sql } from "drizzle-orm";
import type { AgentRepoStore } from "@intx/hub-sessions";

import type { HubDb } from "../db";
import { resolveTimelinePrincipalIds } from "./principal-activity";
import { readTurnInputSnapshot } from "./turn-input-snapshot";

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

// Resolve the on-disk agent-state repo address for an inference turn's
// instance. The address is the repo key the hub stores pushed state packs
// under; null when the instance row is gone.
async function resolveInstanceAddress(
  db: HubDb,
  instanceId: string,
): Promise<string | null> {
  const rows = rowsOf(
    await db.execute(
      sql`select address from agent_instance where id = ${instanceId} limit 1`,
    ),
  );
  return toStringOrNull(rows[0]?.["address"]);
}

async function turnDetail(
  db: HubDb,
  repoStore: AgentRepoStore,
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

  const input = await resolveTurnInput(db, repoStore, {
    instanceId: toStringOrNull(row["instance_id"]),
    startedAt: row["started_at"],
  });

  return {
    ...base,
    turn: {
      model: toStringOrNull(row["model"]),
      durationMs: toNumberOrNull(row["duration_ms"]),
      parts,
      ...input,
    },
  };
}

// Read the turn's input conversation from the hub-durable agent-state repo,
// shaped as the `{ input }` / `{ inputGap }` fields the turn detail carries.
async function resolveTurnInput(
  db: HubDb,
  repoStore: AgentRepoStore,
  turn: { instanceId: string | null; startedAt: unknown },
): Promise<{ input: MomentTurnInputMessage[] } | { inputGap: string }> {
  if (turn.instanceId === null) {
    return { inputGap: "The agent for this turn is no longer available." };
  }
  const startedAtMs = new Date(
    turn.startedAt as string | number | Date,
  ).getTime();
  if (!Number.isFinite(startedAtMs)) {
    return { inputGap: "This turn has no recorded start time to align on." };
  }
  const address = await resolveInstanceAddress(db, turn.instanceId);
  if (address === null) {
    return { inputGap: "The agent for this turn is no longer available." };
  }
  const snapshot = await readTurnInputSnapshot(repoStore, {
    address,
    startedAtMs,
  });
  return "gap" in snapshot
    ? { inputGap: snapshot.gap }
    : { input: snapshot.messages };
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
  repoStore: AgentRepoStore;
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
    detail = await turnDetail(args.db, args.repoStore, base, scope);
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
