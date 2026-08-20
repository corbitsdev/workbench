// Workflow-asset materialization on the sidecar's local substrate: the
// deploy-time `sources.json` disk-convention write an in-process onTrigger
// body child reads its inference-source pins back from. The body DEFINITION
// is never staged -- it is resolved in-memory from the parent's re-verified
// closure.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join as pathJoin } from "node:path";

import type { AgentDeployFrame } from "@intx/types/sidecar";

/**
 * Materialize an extracted onTrigger body's per-step inference-source pins to
 * `${dataDir}/assets/workflow/<bodyRef>/sources.json`. A body child runs
 * in-process with no process env and loses its env across a restart, so its
 * sources must be durable on disk; the body invoker reads this file to build
 * the body's inference-source resolver. Idempotent content-compare write.
 */
export async function materializeWorkflowSources(
  sidecarDataDir: string | undefined,
  definitionId: string,
  sources: NonNullable<AgentDeployFrame["workflow"]>["sources"],
): Promise<void> {
  if (typeof sidecarDataDir !== "string" || sidecarDataDir.length === 0) {
    throw new Error(
      "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the workflow-process child resolves the workflow-asset repo dir against this data dir",
    );
  }
  const sourcesAssetPath = pathJoin(
    sidecarDataDir,
    "assets",
    "workflow",
    definitionId,
    "sources.json",
  );
  const sourcesAssetBytes = JSON.stringify(sources, null, 2);
  try {
    await mkdir(dirname(sourcesAssetPath), { recursive: true });
    // Idempotent: only rewrite when the on-disk content differs. Treats a
    // missing file as different.
    let existing: string | null = null;
    try {
      existing = await readFile(sourcesAssetPath, "utf8");
    } catch (cause) {
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        (cause as { code: unknown }).code === "ENOENT"
      )) {
        throw cause;
      }
    }
    if (existing !== sourcesAssetBytes) {
      await writeFile(sourcesAssetPath, sourcesAssetBytes, "utf8");
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar deploy router: failed to materialize sources.json at ${sourcesAssetPath}: ${reason}`,
      { cause },
    );
  }
}
