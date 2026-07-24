/**
 * CL-4213 — dedupe Granola call processing on artifact `sourceRef` instead of
 * a bespoke work-unit queue. Each processed call writes three typed artifacts
 * (pain points, summary, brief), each keyed by a deterministic per-kind
 * `sourceRef` (`granolaCallSourceRef(noteId, kind)`, in place since CL-3647).
 * The partial unique index `artifact_tenant_source_ref_uniq` on
 * (tenantId, sourceRef) is the database-enforced backstop; this module is the
 * pre-flight check that avoids paying for an LLM turn on a call already done.
 *
 * Partial-write behavior (decided, not implicit — CL-4213):
 * a call is "processed" only when ALL THREE artifacts exist. If a prior run
 * wrote some but not all three (crash between persist steps, a transient
 * failure on one `write_artifact` call, etc.), this reports "not processed"
 * and a re-run is allowed. That re-run reprocesses the whole call (a fresh
 * LLM turn — no atomic three-artifact write is built here), but
 * `write_artifact`'s own sourceRef dedupe (apps/hub/src/tools/write-artifact.ts)
 * makes re-persisting an artifact that already landed a no-op update rather
 * than a duplicate row, and the unique index rejects any concurrent duplicate
 * insert outright. So a partial-write call safely completes on the next run;
 * nothing is ever double-created.
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  GRANOLA_CALL_ARTIFACT_KINDS,
  granolaCallSourceRef,
} from "@workbench/shared";
import { artifact } from "../db/schema";
import type { HubDb } from "../db";

/** The three per-kind `sourceRef`s that together identify one processed call. */
export function granolaCallSourceRefs(noteId: string): string[] {
  return Object.values(GRANOLA_CALL_ARTIFACT_KINDS).map((kind) =>
    granolaCallSourceRef(noteId, kind),
  );
}

/**
 * True only when all three artifacts for this (tenant, note) already exist.
 * Anything less — zero, one, or two — is treated as "not processed" so a
 * re-run fills in exactly the missing artifacts (see module doc above).
 *
 * This is a pre-flight optimization, not the correctness mechanism: even if
 * two concurrent callers both see `false` and both start processing, the
 * `artifact_tenant_source_ref_uniq` partial unique index rejects whichever
 * write loses the race for each sourceRef. Correctness never depends on this
 * check winning a race.
 */
export async function granolaCallArtifactsProcessed(
  db: HubDb,
  tenantId: string,
  noteId: string,
): Promise<boolean> {
  const sourceRefs = granolaCallSourceRefs(noteId);
  const rows = await db
    .select({ sourceRef: artifact.sourceRef })
    .from(artifact)
    .where(
      and(
        eq(artifact.tenantId, tenantId),
        inArray(artifact.sourceRef, sourceRefs),
      ),
    );
  const found = new Set(rows.map((r) => r.sourceRef));
  return sourceRefs.every((ref) => found.has(ref));
}
