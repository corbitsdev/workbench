import { and, eq, isNull } from "drizzle-orm";
import { type } from "arktype";
import { schema as intxSchema } from "@intx/db";
import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import type { ApprovalsEventBus } from "./approvals-events";
import { publishNativeApprovalUpdated } from "./native-approval-notify";

const { approval } = intxSchema;

const log = getLogger(["api", "native-approvals", "enrich"]);

// Ceiling on the serialized tool arguments persisted onto the approval row. The
// snapshot is approver-facing context, not the tool's real input (that rides the
// suspension itself), so a huge payload is truncated to a bounded preview rather
// than bloating the row. ~8KB is generous for a decision surface.
const MAX_TOOL_ARGUMENTS_BYTES = 8 * 1024;

// Argument values whose KEY matches a credential-shaped name are redacted before
// persist: the snapshot is broadcast to every tenant member's ReviewGate, so a
// token/secret in a tool argument must never land in the row.
const SECRET_KEY_PATTERN =
  /token|secret|password|api[_-]?key|authorization|bearer/i;
const REDACTED = "[redacted]";

function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key)
        ? REDACTED
        : redactSecretValues(inner);
    }
    return out;
  }
  return value;
}

/**
 * Redact credential-keyed values, then cap the serialized size. An oversized
 * payload is replaced by a bounded preview marked `__truncated` (a valid JSONB
 * object) rather than persisting the full blob.
 */
export function sanitizeToolArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactSecretValues(args) as Record<string, unknown>;
  const serialized = JSON.stringify(redacted);
  if (serialized.length > MAX_TOOL_ARGUMENTS_BYTES) {
    return {
      __truncated: true,
      preview: serialized.slice(0, MAX_TOOL_ARGUMENTS_BYTES),
    };
  }
  return redacted;
}

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
  bus?: ApprovalsEventBus,
): NativeApprovalEnricher {
  const buffered = new Map<string, ApprovalToolSnapshot>();

  async function applyIfBuffered(
    correlationId: string,
  ): Promise<{ id: string; tenantId: string } | undefined> {
    const snapshot = buffered.get(correlationId);
    if (snapshot === undefined) return undefined;
    // The predicate keys on `correlationId` alone — no tenant scope. The column
    // is globally unique (a DB unique constraint on `approval.correlation_id`),
    // so a snapshot can only ever match its own suspension's row; the reactor
    // emit carries no tenant/deployment to scope by without extra plumbing.
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
      .returning({ id: approval.id, tenantId: approval.tenantId });
    // A returned row means the update enriched a previously-unenriched row. When
    // the `IS NULL` guard matches nothing (row absent, or already enriched) the
    // returning is empty. Distinguish only "row present" from "row absent" for
    // the buffer drop: if the row exists at all the snapshot has done its job.
    const enriched = applied[0];
    const rowExists =
      enriched !== undefined ||
      (await db
        .select({ id: approval.id })
        .from(approval)
        .where(eq(approval.correlationId, correlationId))
        .limit(1)
        .then((rows) => rows.length > 0));
    if (rowExists) buffered.delete(correlationId);
    return enriched;
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
      bufferSnapshot({
        ...parsed,
        toolArguments: sanitizeToolArguments(parsed.toolArguments),
      });
      try {
        const enriched = await applyIfBuffered(parsed.correlationId);
        // Snapshot-after-created: the row already existed, so its "created" event
        // fired without the snapshot. Publish "updated" so an open ReviewGate
        // refetches and picks up the action + args. Snapshot-before-created
        // enriches via `enrichOnCreated` BEFORE "created" fires (that event
        // carries the snapshot), so the created-side path never publishes here.
        if (enriched !== undefined && bus !== undefined) {
          publishNativeApprovalUpdated(bus, enriched.tenantId, enriched.id);
        }
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
