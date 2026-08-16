// Reads tool calls straight off the platform's own `inference_turn` /
// `turn_part` tables — the same rows `@intx/hub-sessions`' event
// collector writes for every turn (vendor/intx/hub-sessions/src/event-
// collector.ts) and `@corbits/insights`' `createDrizzleRunTraceReader`
// (packages/insights/src/trace-reader.ts) reads to build a run's
// trace.
//
// This target reads the raw table instead of going through Insights'
// `/runs/:runId/trace` HTTP route on purpose: that route's
// `RunTraceSpan` intentionally drops a tool call's arguments and a
// *successful* call's result content (only a *failed* call's error
// text survives onto a span — see queries.ts's `RunTraceSpan` doc
// comment). A scorer like `memoryWritten` needs to see what was
// actually written, not just that `memory_add` fired and didn't
// error, so this reads `turn_part.metadata` directly — the full
// `{kind:"call", arguments}` / `{kind:"result", content}` pair the
// event collector already recorded, before Insights' read layer
// summarizes it away.
//
// [Observability gap worth flagging upstream: the Insights trace
// route has no query-param to opt into full arguments/content — today
// the only way to get them is this direct table read, which requires
// the eval harness to hold its own Postgres connection rather than
// going through the hub's own HTTP surface like every other target
// action does.]
//
// `inference_turn.runId` is stored as the DB column `instance_id`
// (see vendor/intx/db/src/schema/messages.ts) — the same id as the
// workflow run itself, which for a `kind: "chat"` channel launched
// directly against a definition (as this target's Myra channel is)
// equals the channel id returned from `POST /channels`.
import type { ToolCall } from "../types.ts";

export interface SqlClientLike {
  unsafe(query: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

type ToolPartMetadata =
  | { kind: "call"; callId: string; name: string; arguments: unknown }
  | { kind: "result"; callId: string; content: unknown; isError: boolean };

function isToolPartMetadata(value: unknown): value is ToolPartMetadata {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "call" || kind === "result";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Every completed tool call (call paired with its result) recorded so
 * far for the given run, in the order the platform recorded them. A
 * call with no result yet (the turn is still in flight) is omitted —
 * never a fabricated in-progress record.
 */
export async function readAllToolCalls(
  sql: SqlClientLike,
  tenantId: string,
  runId: string,
): Promise<ToolCall[]> {
  const rows = await sql.unsafe(
    `SELECT tp.metadata AS metadata, tp.ordinal AS ordinal, it.started_at AS started_at
     FROM turn_part tp
     JOIN inference_turn it ON it.id = tp.turn_id
     WHERE it.instance_id = $1 AND it.tenant_id = $2
     ORDER BY it.started_at ASC, tp.ordinal ASC`,
    [runId, tenantId],
  );

  const calls = new Map<
    string,
    { name: string; arguments: Record<string, unknown> }
  >();
  const results = new Map<string, { content: unknown; isError: boolean }>();
  const order: string[] = [];

  for (const row of rows) {
    const metadata: unknown =
      typeof row["metadata"] === "string"
        ? JSON.parse(row["metadata"] as string)
        : row["metadata"];
    if (!isToolPartMetadata(metadata)) continue;
    if (metadata.kind === "call") {
      calls.set(metadata.callId, {
        name: metadata.name,
        arguments: asRecord(metadata.arguments),
      });
      order.push(metadata.callId);
    } else {
      results.set(metadata.callId, {
        content: metadata.content,
        isError: metadata.isError,
      });
    }
  }

  const out: ToolCall[] = [];
  for (const callId of order) {
    const call = calls.get(callId);
    const callResult = results.get(callId);
    if (call === undefined || callResult === undefined) continue;
    const content =
      typeof callResult.content === "string"
        ? callResult.content
        : JSON.stringify(callResult.content);
    out.push({
      name: call.name,
      arguments: call.arguments,
      isError: callResult.isError,
      result: content,
    });
  }
  return out;
}

/** Splits `all` into calls already reported (`alreadyConsumed`) and
 * calls new since the last poll — turn_part rows are append-only per
 * run, so "new" is simply "beyond the count already consumed". */
export function newToolCallsSince(
  all: readonly ToolCall[],
  alreadyConsumed: number,
): { newCalls: ToolCall[]; consumed: number } {
  return { newCalls: all.slice(alreadyConsumed), consumed: all.length };
}
