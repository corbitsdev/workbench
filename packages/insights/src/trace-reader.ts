// Drizzle-backed RunTraceReader over the platform's own workflow_run /
// inference_turn / turn_part tables. No new storage: inference_turn and
// turn_part are the rows @intx/hub-sessions' event-collector already
// writes for every turn a run takes (chat or workflow-triggered alike —
// inference_turn.runId names the driving workflow_run regardless of
// origin). workflow_run_execution, despite existing in the schema, has no
// writer anywhere in the platform today, so it is not read here: reading
// it would render every run's trace empty forever, the same silent gap
// this reader replaces.
import { and, asc, eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { inferenceTurn, turnPart, workflowRun } from "@intx/db/schema";

import type { RunTrace, RunTraceReader, RunTraceSpan } from "./queries";

type ToolPartMetadata =
  | { kind: "call"; callId: string; name: string; arguments: unknown }
  | { kind: "result"; callId: string; content: unknown; isError: boolean };

function isToolPartMetadata(value: unknown): value is ToolPartMetadata {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "call" || kind === "result";
}

type TurnPartRow = {
  id: string;
  content: string | null;
  metadata: unknown;
  ordinal: number;
};

/**
 * Positions a sub-turn span within its enclosing turn's real
 * [start, end] wall-clock window. turn_part carries no timestamp of its
 * own, only an `ordinal` — so position is derived from event sequence,
 * clamped to the turn's own span rather than a fabricated instant outside
 * it.
 */
function positionInTurn(
  ordinal: number,
  turnStart: number,
  turnEnd: number,
): number {
  return Math.min(turnStart + ordinal, turnEnd);
}

function errorSpans(
  parts: readonly TurnPartRow[],
  turnStart: number,
  turnEnd: number,
): RunTraceSpan[] {
  return parts
    .filter(
      (part): part is TurnPartRow & { content: string } =>
        typeof part.content === "string",
    )
    .map((part) => {
      const at = positionInTurn(part.ordinal, turnStart, turnEnd);
      return {
        id: part.id,
        label: "Error",
        kind: "error",
        start: at,
        end: at,
        durationMs: null,
        tokens: null,
        phase: "failed",
        error: part.content,
      };
    });
}

/**
 * Pairs "call" and "result" tool parts by callId within a single turn and
 * emits one span per tool call. A call with no matching result yet (the
 * turn is still running) renders as `awaiting`, never a fabricated
 * completion.
 */
function toolCallSpans(
  parts: readonly TurnPartRow[],
  turnStart: number,
  turnEnd: number,
): RunTraceSpan[] {
  const calls = new Map<
    string,
    { partId: string; name: string; ordinal: number }
  >();
  const results = new Map<string, { content: unknown; isError: boolean }>();

  for (const part of parts) {
    if (!isToolPartMetadata(part.metadata)) continue;
    if (part.metadata.kind === "call") {
      calls.set(part.metadata.callId, {
        partId: part.id,
        name: part.metadata.name,
        ordinal: part.ordinal,
      });
    } else {
      results.set(part.metadata.callId, {
        content: part.metadata.content,
        isError: part.metadata.isError,
      });
    }
  }

  const spans: RunTraceSpan[] = [];
  for (const [callId, call] of calls) {
    const result = results.get(callId);
    const at = positionInTurn(call.ordinal, turnStart, turnEnd);
    spans.push({
      id: call.partId,
      label: call.name,
      kind: "tool",
      start: at,
      end: at,
      durationMs: null,
      tokens: null,
      phase:
        result === undefined ? "awaiting" : result.isError ? "failed" : "ok",
      error:
        result?.isError === true
          ? typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content)
          : null,
      // See RunTraceSpan.authz doc comment: verdicts live only in the
      // sidecar-side git audit trail, unreachable from here today.
      authz: null,
    });
  }
  return spans;
}

/**
 * Reads a run's trace off the platform's own tables: one span per
 * inference_turn (real started_at/ended_at timing, the same rows the
 * event-collector writes as each turn opens and settles), plus tool-call
 * and error sub-spans pulled from that turn's turn_part rows (positioned
 * by event seq, since turn_part carries no timestamp of its own). A run
 * outside this tenant, or with no matching workflow_run row, reads as
 * absent (null) — never an empty trace standing in for "not found". A run
 * that exists but has taken no turns yet reads as an empty span list, not
 * absent.
 */
export function createDrizzleRunTraceReader(db: DB["db"]): RunTraceReader {
  return {
    async getTrace(tenantId, runId): Promise<RunTrace | null> {
      const run = await db.query.workflowRun.findFirst({
        where: and(
          eq(workflowRun.id, runId),
          eq(workflowRun.tenantId, tenantId),
        ),
      });
      if (run === undefined) return null;

      const turns = await db.query.inferenceTurn.findMany({
        where: and(
          eq(inferenceTurn.runId, runId),
          eq(inferenceTurn.tenantId, tenantId),
        ),
        orderBy: asc(inferenceTurn.startedAt),
      });

      const spans: RunTraceSpan[] = [];

      for (const [index, turn] of turns.entries()) {
        const start = turn.startedAt.getTime();
        const end = turn.endedAt?.getTime() ?? Date.now();
        const parts = await db.query.turnPart.findMany({
          where: eq(turnPart.turnId, turn.id),
          orderBy: asc(turnPart.ordinal),
        });
        const errorParts = parts.filter((part) => part.type === "error");

        spans.push({
          id: turn.id,
          label: `Turn ${index + 1}`,
          kind: "turn",
          start,
          end,
          durationMs: turn.endedAt === null ? null : end - start,
          tokens: null,
          phase:
            turn.status === "completed"
              ? "ok"
              : turn.status === "failed"
                ? "failed"
                : "awaiting",
          error:
            turn.status === "failed" ? (errorParts[0]?.content ?? null) : null,
        });

        spans.push(...toolCallSpans(parts, start, end));
        spans.push(...errorSpans(errorParts, start, end));
      }

      spans.sort((a, b) => a.start - b.start);

      return { runId, spans };
    },
  };
}
