import { and, eq, isNull } from "drizzle-orm";
import { type } from "arktype";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";

const { approval } = intxSchema;

const log = getLogger(["api", "native-approvals", "enrich"]);

/**
 * The tool snapshot the reactor surfaces on `custom.approval.requested` at an
 * authz `ask` suspension (see `packages/inference/src/reactor.ts`). It is the
 * only carrier of the parked tool's name + arguments — interchange's own
 * suspend-time co-write leaves `toolDefinition`/`toolArguments` null. Parsed at
 * this trust boundary because it arrives off the sidecar inference-event wire.
 */
export const ApprovalToolSnapshotSchema = type({
  correlationId: "string",
  callId: "string",
  toolName: "string",
  toolArguments: "Record<string, unknown>",
});

export type ApprovalToolSnapshot = typeof ApprovalToolSnapshotSchema.infer;

// Cap on buffered, not-yet-applicable snapshots. A snapshot buffers only while
// its approval row does not yet exist; the row is co-written within the same
// suspension, so the buffer is normally near-empty and drains within one
// register round-trip. The cap is a memory backstop for the pathological case
// where a snapshot's row never appears (a suspension the register frame never
// reached): oldest entries are evicted so the map cannot grow unbounded.
const MAX_BUFFERED_SNAPSHOTS = 1000;

export interface NativeApprovalEnricher {
  /**
   * Record the reactor's tool snapshot for a suspension. Parses the raw wire
   * payload, then attempts to enrich the approval row immediately; if the row
   * is not yet co-written it buffers, keyed by `correlationId`, and applies on
   * the later `enrichOnCreated`. Never throws — a parse or DB failure is logged
   * and swallowed so it cannot corrupt the inference-event fan-out.
   */
  recordToolSnapshot(raw: unknown): Promise<void>;
  /**
   * Apply any buffered snapshot for a just-created approval row. Called after
   * interchange's `registerSignalCorrelation` co-write commits, covering the
   * order where the snapshot arrived before the row existed.
   */
  enrichOnCreated(correlationId: string): Promise<void>;
}

/**
 * Buffers the reactor's suspend-time tool snapshot and writes it onto the
 * native `approval` row (`toolDefinition = { name }`, `toolArguments`) keyed by
 * `correlationId` (CL-3940). The snapshot (custom inference event) and the row
 * (interchange's `registerSignalCorrelation` co-write) race, so both arrival
 * orders are handled: `recordToolSnapshot` tries the write and buffers on a
 * miss; `enrichOnCreated` retries from the buffer once the row exists. The join
 * key is the per-suspension `correlationId`, so concurrent gated calls never
 * cross-contaminate. The write is idempotent (`toolDefinition IS NULL` guard),
 * so a redelivered snapshot never clobbers an already-enriched row.
 */
export function createNativeApprovalEnricher(
  db: HubDb,
): NativeApprovalEnricher {
  const buffered = new Map<string, ApprovalToolSnapshot>();

  async function applyIfBuffered(correlationId: string): Promise<void> {
    const snapshot = buffered.get(correlationId);
    if (snapshot === undefined) return;
    const applied = await db
      .update(approval)
      .set({
        toolDefinition: { name: snapshot.toolName },
        toolArguments: snapshot.toolArguments,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(approval.correlationId, correlationId),
          isNull(approval.toolDefinition),
        ),
      )
      .returning({ id: approval.id });
    // A hit means the row exists and was enriched (or was already enriched, in
    // which case the `IS NULL` guard returned zero and we still drop the buffer
    // entry so it does not linger). Distinguish only "row present" from "row
    // absent": if the row exists at all the snapshot has done its job.
    const rowExists =
      applied.length > 0 ||
      (await db
        .select({ id: approval.id })
        .from(approval)
        .where(eq(approval.correlationId, correlationId))
        .limit(1)
        .then((rows) => rows.length > 0));
    if (rowExists) buffered.delete(correlationId);
  }

  function bufferSnapshot(snapshot: ApprovalToolSnapshot): void {
    if (
      !buffered.has(snapshot.correlationId) &&
      buffered.size >= MAX_BUFFERED_SNAPSHOTS
    ) {
      const oldest = buffered.keys().next().value;
      if (oldest !== undefined) buffered.delete(oldest);
    }
    buffered.set(snapshot.correlationId, snapshot);
  }

  return {
    async recordToolSnapshot(raw) {
      const parsed = ApprovalToolSnapshotSchema(raw);
      if (parsed instanceof type.errors) {
        log.warn("dropping malformed approval tool snapshot", {
          error: parsed.summary,
        });
        return;
      }
      bufferSnapshot(parsed);
      try {
        await applyIfBuffered(parsed.correlationId);
      } catch (err) {
        log.warn("native approval enrich (on snapshot) failed", {
          correlationId: parsed.correlationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    async enrichOnCreated(correlationId) {
      try {
        await applyIfBuffered(correlationId);
      } catch (err) {
        log.warn("native approval enrich (on created) failed", {
          correlationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
