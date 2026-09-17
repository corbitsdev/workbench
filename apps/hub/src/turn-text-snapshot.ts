// Reads the visible text already streamed for a chat turn straight off the
// platform's own inference_turn / turn_part tables (CL-6380) — the same
// tables `trace-reader.ts` reads, no new storage. A chat `AgentTurn`'s
// `childRunId` names the workflow_run that produced it, and `inferenceTurn`
// rows key on that same run id (one inference_turn per LLM call within the
// turn, e.g. one per tool-loop step); `turn_part` rows of type "text" only
// land once their inference call reaches `inference.done` — mid-call token
// deltas never get an intermediate row — so a turn still streaming its
// first inference call reads back an empty snapshot, not an error: the
// caller's live tail (the SSE stream reattaching) is what carries the rest.
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DB } from "@intx/db";
import { inferenceTurn, turnPart } from "@intx/db/schema";

export interface TurnTextSnapshotReader {
  /** The visible text this turn has committed to `turn_part` so far, in
   * inference-call then ordinal order — the "part cursor" catch-up a
   * client reattaching mid-turn replays before the live tail resumes.
   * `null` for a run with no turns yet (nothing to reconstruct), never for
   * one that simply hasn't produced text yet (that reads as `""`). */
  read(input: {
    readonly tenantId: string;
    readonly runId: string;
  }): Promise<string | null>;
}

/** Pure so the reconstruction rule is testable without a database: text
 * parts only, concatenated turn-by-turn (oldest first) and, within a turn,
 * ordinal-by-ordinal — mirrors the collector's own `accumulatedText`
 * (`vendor/intx/hub-sessions/src/event-collector.ts`) without depending on
 * it. */
export function snapshotTextFromParts(
  turnIdsOldestFirst: readonly string[],
  parts: readonly {
    readonly turnId: string;
    readonly content: string | null;
    readonly type: string;
    readonly ordinal: number;
  }[],
): string {
  const byTurn = new Map<string, { content: string; ordinal: number }[]>();
  for (const part of parts) {
    if (part.type !== "text" || part.content === null) continue;
    const bucket = byTurn.get(part.turnId);
    const entry = { content: part.content, ordinal: part.ordinal };
    if (bucket === undefined) byTurn.set(part.turnId, [entry]);
    else bucket.push(entry);
  }
  let text = "";
  for (const turnId of turnIdsOldestFirst) {
    const bucket = byTurn.get(turnId);
    if (bucket === undefined) continue;
    for (const part of [...bucket].sort((a, b) => a.ordinal - b.ordinal)) {
      text += part.content;
    }
  }
  return text;
}

export function createDrizzleTurnTextSnapshotReader(
  db: DB["db"],
): TurnTextSnapshotReader {
  return {
    async read({ tenantId, runId }) {
      const turns = await db.query.inferenceTurn.findMany({
        where: and(
          eq(inferenceTurn.runId, runId),
          eq(inferenceTurn.tenantId, tenantId),
        ),
        orderBy: asc(inferenceTurn.startedAt),
      });
      if (turns.length === 0) return null;

      const parts = await db.query.turnPart.findMany({
        where: inArray(
          turnPart.turnId,
          turns.map((turn) => turn.id),
        ),
        orderBy: asc(turnPart.ordinal),
      });

      return snapshotTextFromParts(
        turns.map((turn) => turn.id),
        parts,
      );
    },
  };
}
