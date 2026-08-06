// Workflow-asset materialization on the sidecar's local substrate:
// the deploy-time `workflow.json` / `sources.json` disk-convention
// writes the workflow-process child reads back, and the boot-time
// restore's re-read of the definition off the same convention.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join as pathJoin } from "node:path";

import type { AgentDeployFrame } from "@intx/types/sidecar";

/**
 * Materialize the workflow definition on the sidecar's local substrate so
 * the workflow-process child's `loadWorkflowDefinition` can read
 * `workflow.json` out of the workflow-asset repo's working tree. The
 * destination mirrors the bare RepoStore's `getRepoDir` for
 * `{ kind: "workflow", id }`:
 * `${SIDECAR_DATA_DIR}/assets/workflow/<id>/workflow.json`. The child reads
 * via `fs.readFile`, so writing the bytes outside git suffices. This is
 * deploy-only durable state; the restore path finds it already on disk.
 */
export async function materializeWorkflowJson(
  sidecarDataDir: string | undefined,
  definition: NonNullable<AgentDeployFrame["workflow"]>["definition"],
): Promise<void> {
  if (typeof sidecarDataDir !== "string" || sidecarDataDir.length === 0) {
    throw new Error(
      "sidecar deploy router: SIDECAR_DATA_DIR must be present in the multi-step substrate env; the workflow-process child resolves the workflow-asset repo dir against this data dir",
    );
  }
  const workflowAssetPath = pathJoin(
    sidecarDataDir,
    "assets",
    "workflow",
    definition.id,
    "workflow.json",
  );
  const workflowAssetBytes = JSON.stringify(definition, null, 2);
  try {
    await mkdir(dirname(workflowAssetPath), { recursive: true });
    // Idempotent: only rewrite when the on-disk content differs. Treats a
    // missing file as different.
    let existing: string | null = null;
    try {
      existing = await readFile(workflowAssetPath, "utf8");
    } catch (cause) {
      if (!(
        cause instanceof Error &&
        "code" in cause &&
        (cause as { code: unknown }).code === "ENOENT"
      )) {
        throw cause;
      }
    }
    if (existing !== workflowAssetBytes) {
      await writeFile(workflowAssetPath, workflowAssetBytes, "utf8");
    }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `sidecar deploy router: failed to materialize workflow.json at ${workflowAssetPath}: ${reason}`,
      { cause },
    );
  }
}

/**
 * Materialize an extracted onTrigger body's per-step inference-source pins to
 * `${dataDir}/assets/workflow/<bodyRef>/sources.json`, co-located with the
 * body's `workflow.json`. A body child runs in-process with no process env
 * and loses its env across a restart, so its sources must be durable on disk
 * beside the body definition; the body invoker reads this file to build the
 * body's inference-source resolver. Mirrors `materializeWorkflowJson`: same
 * per-body dir, idempotent content-compare write.
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

/**
 * Read a workflow definition back off the sidecar's local substrate for a
 * boot-time restore. Mirrors `materializeWorkflowJson`'s path derivation
 * (`${dataDir}/assets/workflow/<definitionId>/workflow.json`). Returns the
 * parsed-but-unvalidated JSON: the on-disk file is untrusted at restore
 * (partial write, corruption, tamper), so the caller re-validates it through
 * the same wire + structural gates the deploy path applies. A missing file
 * or unparseable JSON throws; the restore loop's per-record catch converts
 * that into a warn-and-skip.
 */
export async function readWorkflowJson(
  sidecarDataDir: string,
  definitionId: string,
): Promise<unknown> {
  const workflowAssetPath = pathJoin(
    sidecarDataDir,
    "assets",
    "workflow",
    definitionId,
    "workflow.json",
  );
  const raw = await readFile(workflowAssetPath, "utf8");
  return JSON.parse(raw);
}
