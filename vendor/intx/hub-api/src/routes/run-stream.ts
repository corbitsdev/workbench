// Live progress stream and saved inference-step traces for a workflow run.
//
// Why `GET /:runId/stream` projects events instead of forwarding raw
// `InferenceEvent`s:
//   1. Every streaming delta (`inference.text.delta`, `inference.thinking.delta`)
//      carries the full `partial: PartialMessage`, so forwarding raw events
//      makes wire traffic grow quadratically with turn length.
//   2. Raw events carry provider `signature` and `redacted_thinking` blobs that
//      belong to the session echo-back layer, never the browser.
//   3. Tool arguments and outputs can be arbitrarily large, so strings are
//      capped at `MAX_TRACE_TEXT_CHARS` (4 KB) at the hub boundary.
//
// `GET /:runId/inference-turns` serves the `inference_turn` and `turn_part`
// rows the event collector writes at the end of each step, so a reloaded chat
// shows the same reasoning and tool traces that streamed live.

import { type } from "arktype";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { describeRoute } from "hono-openapi";

import type { DB } from "@intx/db";
import { inferenceTurn, turnPart } from "@intx/db/schema";
import {
  findRoutableById,
  type EventCollectorRegistry,
  type SidecarRouter,
} from "@intx/hub-sessions";
import { ErrorResponse } from "@intx/types";
import { parseInferenceEvent, type InferenceEvent } from "@intx/types/runtime";

import type { TenantEnv } from "../context";
import { errorResponse } from "../error-response";
import { ts } from "../format";
import { idResource, type RequireGrant } from "../middleware/grant";
import { jsonResponse } from "../openapi";

const MAX_TRACE_TEXT_CHARS = 4000;
const HEARTBEAT_MS = 25_000;
// In `e2e/lib/browser.ts`, `Bun.serve` runs with its default 10s `idleTimeout`.
// Closing a stream that has already flushed chunks after 8s of silence sends
// the terminating `0\r\n\r\n` chunk cleanly before `Bun.serve` can abort the
// socket mid-stream (`net::ERR_INCOMPLETE_CHUNKED_ENCODING`).
const FLUSHED_IDLE_CLOSE_MS = 8_000;

export type RunStreamStatus = "idle" | "busy" | "waiting_approval";

export type RunStreamFrame =
  | {
      readonly type: "snapshot";
      readonly status: RunStreamStatus;
      readonly text: string;
    }
  | { readonly type: "status"; readonly status: RunStreamStatus }
  | { readonly type: "step.started" }
  | { readonly type: "reasoning.delta"; readonly token: string }
  | { readonly type: "text.delta"; readonly token: string }
  | { readonly type: "step.done"; readonly reasoning?: string }
  | {
      readonly type: "tool.call";
      readonly callId: string;
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | {
      readonly type: "tool.result";
      readonly callId: string;
      readonly content: string;
      readonly isError: boolean;
    }
  | { readonly type: "turn.committed" };

export const SavedTurnPartResponse = type({
  kind: "'reasoning'",
  text: "string",
})
  .or({
    kind: "'tool-call'",
    callId: "string",
    name: "string",
    arguments: "Record<string, unknown>",
  })
  .or({
    kind: "'tool-result'",
    callId: "string",
    content: "string",
    isError: "boolean",
  })
  .or({
    kind: "'error'",
    message: "string",
  });

export type SavedTurnPart = typeof SavedTurnPartResponse.infer;

export const SavedInferenceTurnResponse = type({
  id: "string",
  startedAt: "string",
  endedAt: "string | null",
  status: "'running' | 'completed' | 'failed'",
  parts: SavedTurnPartResponse.array(),
});

export type SavedInferenceTurn = typeof SavedInferenceTurnResponse.infer;

export const RunInferenceTurnsResponse = type({
  runId: "string",
  turns: SavedInferenceTurnResponse.array(),
});

function truncateText(text: string): string {
  return text.length <= MAX_TRACE_TEXT_CHARS
    ? text
    : `${text.slice(0, MAX_TRACE_TEXT_CHARS)}…`;
}

function truncateArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const truncated: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    truncated[key] = typeof value === "string" ? truncateText(value) : value;
  }
  return truncated;
}

function formatToolContent(content: unknown): string {
  const raw =
    typeof content === "string" ? content : JSON.stringify(content ?? "");
  return truncateText(raw);
}

// In `EventCollector`, each step of a multi-step tool loop opens its own
// `inference_turn` row. When the next step begins, `beginTurn` finalizes the
// previous step with `hadReply: false`, which fires `onTurnFinalized` ->
// `turn.committed` mid-loop. Only a commit with `hadReply: true` (after
// `connector.reply`) or `status: "failed"` marks the end of the agent's whole
// reply turn.
const TurnCommittedNotification = type({
  type: "'turn.committed'",
  "data?": {
    "hadReply?": "boolean",
    "status?": "string",
  },
});

function isFinalTurnCommit(rawEvent: unknown): boolean {
  const parsed = TurnCommittedNotification(rawEvent);
  if (parsed instanceof type.errors) return false;
  if (parsed.data === undefined) return true;
  return parsed.data.hadReply === true || parsed.data.status === "failed";
}

/**
 * Projects one raw agent event onto a browser-safe `RunStreamFrame`, or `null`
 * when the event has no browser representation (usage counters, non-approval
 * gates, intermediate step commits, etc.).
 */
export function projectRunStreamFrame(rawEvent: unknown): RunStreamFrame | null {
  if (isFinalTurnCommit(rawEvent)) {
    return { type: "turn.committed" };
  }
  const event = parseInferenceEvent(rawEvent);
  if (event instanceof type.errors) return null;
  return projectInferenceEvent(event);
}

function projectInferenceEvent(event: InferenceEvent): RunStreamFrame | null {
  switch (event.type) {
    case "inference.start":
      return { type: "step.started" };

    case "inference.thinking.delta":
      return event.data.token.length > 0
        ? { type: "reasoning.delta", token: event.data.token }
        : null;

    case "inference.text.delta":
      return event.data.token.length > 0
        ? { type: "text.delta", token: event.data.token }
        : null;

    case "inference.done": {
      // Providers that do not stream thinking deltas still emit a `thinking`
      // block on the completed turn; carry it on `step.done` so the client can
      // backfill reasoning when no deltas arrived during the step.
      const reasoning = event.data.turn.content
        .flatMap((block) => (block.type === "thinking" ? [block.thinking] : []))
        .join("");
      return reasoning.length > 0
        ? { type: "step.done", reasoning: truncateText(reasoning) }
        : { type: "step.done" };
    }

    case "tool.start":
      return {
        type: "tool.call",
        callId: event.data.call.id,
        name: event.data.call.name,
        arguments: truncateArguments(event.data.call.arguments),
      };

    case "tool.done":
      return {
        type: "tool.result",
        callId: event.data.result.callId,
        content: formatToolContent(event.data.result.content),
        isError: event.data.result.isError ?? false,
      };

    case "reactor.gate.blocked":
      return event.data.reason === "approval"
        ? { type: "status", status: "waiting_approval" }
        : null;

    case "reactor.gate.cleared":
      return { type: "status", status: "busy" };

    case "reactor.done":
      return { type: "turn.committed" };

    case "reactor.error":
      return event.data.fatal ? { type: "turn.committed" } : null;

    default:
      return null;
  }
}

const PersistedToolCallMeta = type({
  kind: "'call'",
  callId: "string",
  name: "string",
  "arguments?": "Record<string, unknown>",
});

const PersistedToolResultMeta = type({
  kind: "'result'",
  callId: "string",
  "content?": "unknown",
  "isError?": "boolean",
});

const PersistedToolMeta = PersistedToolCallMeta.or(PersistedToolResultMeta);

function shapeSavedPart(row: typeof turnPart.$inferSelect): SavedTurnPart | null {
  switch (row.type) {
    case "reasoning":
      return row.content !== null && row.content.length > 0
        ? { kind: "reasoning", text: truncateText(row.content) }
        : null;

    case "tool": {
      const meta = PersistedToolMeta(row.metadata);
      if (meta instanceof type.errors) return null;
      if (meta.kind === "call") {
        return {
          kind: "tool-call",
          callId: meta.callId,
          name: meta.name,
          arguments: truncateArguments(meta.arguments ?? {}),
        };
      }
      return {
        kind: "tool-result",
        callId: meta.callId,
        content: formatToolContent(meta.content),
        isError: meta.isError === true,
      };
    }

    case "error":
      return row.content !== null && row.content.length > 0
        ? { kind: "error", message: truncateText(row.content) }
        : null;

    default:
      return null;
  }
}

async function readSavedInferenceTurns(
  db: DB["db"],
  tenantId: string,
  runId: string,
  sinceParam: string | undefined,
): Promise<SavedInferenceTurn[]> {
  const sinceMs = sinceParam !== undefined ? Date.parse(sinceParam) : Number.NaN;
  const whereClause = Number.isNaN(sinceMs)
    ? and(eq(inferenceTurn.runId, runId), eq(inferenceTurn.tenantId, tenantId))
    : and(
        eq(inferenceTurn.runId, runId),
        eq(inferenceTurn.tenantId, tenantId),
        gt(inferenceTurn.startedAt, new Date(sinceMs)),
      );

  const turns = await db
    .select()
    .from(inferenceTurn)
    .where(whereClause)
    .orderBy(asc(inferenceTurn.startedAt));
  if (turns.length === 0) return [];

  const partRows = await db
    .select()
    .from(turnPart)
    .where(
      inArray(
        turnPart.turnId,
        turns.map((turn) => turn.id),
      ),
    )
    .orderBy(asc(turnPart.ordinal));

  const partsByTurn = new Map<string, SavedTurnPart[]>();
  for (const row of partRows) {
    const part = shapeSavedPart(row);
    if (part === null) continue;
    const list = partsByTurn.get(row.turnId) ?? [];
    list.push(part);
    partsByTurn.set(row.turnId, list);
  }

  return turns.map((turn) => ({
    id: turn.id,
    startedAt: ts(turn.startedAt),
    endedAt: turn.endedAt === null ? null : ts(turn.endedAt),
    status: turn.status,
    parts: partsByTurn.get(turn.id) ?? [],
  }));
}

export type CreateRunStreamRoutesDeps = {
  readonly db: DB["db"];
  readonly sidecarRouter: Pick<SidecarRouter, "subscribeAgent">;
  readonly eventCollectors: Pick<
    EventCollectorRegistry,
    "getStatus" | "getAccumulatedText"
  >;
  readonly requireGrant: RequireGrant;
};

export function createRunStreamRoutes({
  db,
  sidecarRouter,
  eventCollectors,
  requireGrant,
}: CreateRunStreamRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get(
    "/:runId/stream",
    requireGrant(idResource("workflow-run", "runId"), "read"),
    describeRoute({
      tags: ["Runs"],
      summary: "Stream live run progress",
      description:
        "Server-sent event stream of a run's live inference progress: reasoning, tool calls and results, text tokens, and status changes.",
      responses: {
        404: jsonResponse("Run not found", ErrorResponse),
      },
    }),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const runId = c.req.param("runId");
      const record = await findRoutableById(db, runId, tenantCtx.id);
      if (record === undefined) {
        return errorResponse(c, "not_found", "Run not found");
      }

      return streamSSE(c, async (stream) => {
        let hasWritten = false;
        let lastWriteAt = Date.now();
        const send = (frame: RunStreamFrame): Promise<void> => {
          hasWritten = true;
          lastWriteAt = Date.now();
          return stream
            .writeSSE({ event: "run", data: JSON.stringify(frame) })
            .catch(() => undefined);
        };

        const unsubscribe = sidecarRouter.subscribeAgent(
          record.address,
          (raw) => {
            const frame = projectRunStreamFrame(raw);
            if (frame !== null) void send(frame);
          },
        );
        stream.onAbort(() => unsubscribe());

        // `EventCollector.finalizeTurn` leaves the finished turn's text in
        // `accumulatedText` until the next `beginTurn`, so only read it when
        // the collector is actively mid-turn (`status !== "idle"`).
        const status =
          eventCollectors.getStatus(record.address)?.status ?? "idle";
        if (status !== "idle") {
          const text =
            eventCollectors.getAccumulatedText(record.address) ?? "";
          await send({ type: "snapshot", status, text });
        }

        try {
          while (!stream.aborted) {
            await stream.sleep(
              hasWritten ? FLUSHED_IDLE_CLOSE_MS : HEARTBEAT_MS,
            );
            if (stream.aborted) break;
            if (hasWritten && Date.now() - lastWriteAt >= FLUSHED_IDLE_CLOSE_MS) {
              await stream.close();
              break;
            }
            await stream.write(": heartbeat\n\n");
          }
        } catch {
          // Stream closed or aborted.
        } finally {
          unsubscribe();
        }
      });
    },
  );

  app.get(
    "/:runId/inference-turns",
    requireGrant(idResource("workflow-run", "runId"), "read"),
    describeRoute({
      tags: ["Runs"],
      summary: "List a run's saved inference steps",
      description:
        "Returns the reasoning, tool call, tool result, and error parts the event collector saved for each inference step of the run, ordered oldest first.",
      parameters: [
        {
          name: "since",
          in: "query",
          schema: { type: "string" },
          description: "Return only steps started after this ISO timestamp.",
        },
      ],
      responses: {
        200: jsonResponse("Saved inference steps", RunInferenceTurnsResponse),
        404: jsonResponse("Run not found", ErrorResponse),
      },
    }),
    async (c) => {
      const tenantCtx = c.get("tenant");
      const runId = c.req.param("runId");
      const record = await findRoutableById(db, runId, tenantCtx.id);
      if (record === undefined) {
        return errorResponse(c, "not_found", "Run not found");
      }

      const turns = await readSavedInferenceTurns(
        db,
        tenantCtx.id,
        runId,
        c.req.query("since"),
      );
      return c.json({ runId, turns });
    },
  );

  return app;
}
