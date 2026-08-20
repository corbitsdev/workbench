// Sidecar-local persistence of the per-deployment record needed to
// re-establish a workflow deployment across a sidecar PROCESS restart. The
// record is co-located with the deployment's workflow-run substrate at
// `${dataDir}/workflow-runs/<deploymentId>/deployment.json`, so a single
// teardown reclaims both and a boot scan can enumerate the active
// deployments beside the run state they resume.
//
// It carries only the inputs that are otherwise frame/in-memory only:
// `sources` (each step's ordered inference-source failover chain, threaded to
// the child via the spawn env and durable nowhere else), `sessionId`
// (inference-event
// correlation), `hubPublicKey` (the head's deploy-pack / inbound
// verification key, recorded only in memory today), and
// `referencedDefinitionHashes` (the hub-approved wire hash per referenced
// onTrigger body id, threaded to the child via the spawn env). The
// definition itself lives in `assets/workflow/<definitionId>/workflow.json`,
// referenced by `definitionId`, and each step's grants live in its
// agent-state repo, so neither is duplicated here.

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join as pathJoin } from "node:path";

import { type } from "arktype";

import { getLogger } from "@intx/log";
import { InferenceSource } from "@intx/types/runtime";
import { SourceRefPin } from "@intx/types/sidecar";
import { isErrnoNotFound } from "./conversation-state";

import { writeFileAtomicDurable } from "./atomic-write";

const logger = getLogger(["sidecar", "workflow-deployment-record"]);

const RECORD_FILENAME = "deployment.json";

/**
 * The on-disk deployment record. `version` guards the schema shape so a
 * future reader can reject or migrate a stale record rather than parse it
 * blindly. Validated at read time (the boot scan) at the trust boundary.
 */
export const WorkflowDeploymentRecord = type({
  version: "1",
  agentAddress: "string > 0",
  definitionId: "string > 0",
  sources: {
    "[string]": InferenceSource.array().atLeastLength(1),
  },
  "sessionId?": "string > 0",
  "hubPublicKey?": "string > 0",
  // The hub-approved wire hash the restored child re-verifies its evaluated
  // closure against, rather than a sidecar recompute of the inert projection
  // -- the latter would collapse the out-of-band-pin property the re-verify
  // barrier exists for.
  approvedWireHash: "string > 0",
  // The pin a restore re-runs the closure apply with: `source` names where the
  // definition package comes from (no secret -- the registry token resolves
  // from env at apply time), `closure` is the hub's frozen dependency set
  // (concrete versions + integrity SRIs). Both rode the signed deploy frame.
  sourceRef: SourceRefPin,
  // Written only on the state-preserving hibernate teardown
  // (`teardownDeployment({ reclaimDirs: false })`), never on deploy or
  // rotation. Its presence is the durable answer to "did the hub park this
  // deployment on purpose", as opposed to a record left behind by a crash
  // or a bare process exit -- both of which leave no marker at all. Absent
  // on every record written before this field existed and on every record
  // for a deployment that has never been hibernated; `readWorkflowDeploymentRecord`
  // and the boot scan both treat an absent marker as "live", so an old
  // on-disk record keeps loading and restoring exactly as before.
  "parkedAt?": "string > 0",
});
export type WorkflowDeploymentRecord = typeof WorkflowDeploymentRecord.infer;

function recordPath(dataDir: string, deploymentId: string): string {
  return pathJoin(dataDir, "workflow-runs", deploymentId, RECORD_FILENAME);
}

/**
 * Read one deployment's record by id, for a caller that already knows the
 * deployment id it needs and has no reason to re-scan the whole
 * `workflow-runs/` tree. Returns `undefined` for a missing or unparseable
 * record.
 */
export async function readWorkflowDeploymentRecord(
  dataDir: string,
  deploymentId: string,
): Promise<WorkflowDeploymentRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(recordPath(dataDir, deploymentId), "utf8");
  } catch (cause) {
    if (isErrnoNotFound(cause)) return undefined;
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = WorkflowDeploymentRecord(parsed);
  if (record instanceof type.errors) return undefined;
  return record;
}

/**
 * Persist a deployment record. Written after the deployment's slug is
 * claimed and before the child is spawned, so a crash mid-spawn leaves a
 * record the boot scan re-drives. Idempotent: it overwrites any existing
 * record for the same deployment.
 */
export async function writeWorkflowDeploymentRecord(
  dataDir: string,
  deploymentId: string,
  record: WorkflowDeploymentRecord,
): Promise<void> {
  const path = recordPath(dataDir, deploymentId);
  await mkdir(dirname(path), { recursive: true });
  // Atomic + durable: this is the sole restore source for the
  // deployment's `sources`/`hubPublicKey`, and a rotation overwrites the
  // existing record in place, so an interrupted write must never expose a
  // torn record the boot scan would then skip. Owner-only (0o600): the
  // record embeds each source's `apiKey`, so it must not be world-readable
  // on a shared host, matching the private-key writes elsewhere on the
  // sidecar.
  await writeFileAtomicDurable(path, JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
}

/**
 * Mark an existing deployment record as parked: stamp `parkedAt` with the
 * current time and rewrite the record in place. Called from the
 * state-preserving hibernate teardown, after the record has already been
 * confirmed to exist (a hibernate never writes a fresh record, only
 * annotates the one the original deploy or a later rotation left behind).
 * A missing record is not an error -- there is nothing to mark, and the
 * caller's own "record IS the durable state" invariant means this should
 * not happen outside a race with a concurrent reclaim, which just leaves
 * the reclaim as the last write.
 */
export async function markWorkflowDeploymentRecordParked(
  dataDir: string,
  deploymentId: string,
): Promise<void> {
  const existing = await readWorkflowDeploymentRecord(dataDir, deploymentId);
  if (existing === undefined) return;
  await writeWorkflowDeploymentRecord(dataDir, deploymentId, {
    ...existing,
    parkedAt: new Date().toISOString(),
  });
}

/**
 * Remove a deployment record. Called on undeploy and on a soft-failed
 * deploy so a torn-down or never-completed deployment is not restored on
 * the next boot. A missing record is not an error (`force`).
 */
export async function deleteWorkflowDeploymentRecord(
  dataDir: string,
  deploymentId: string,
): Promise<void> {
  await rm(recordPath(dataDir, deploymentId), { force: true });
}

/** A restorable deployment: its directory-derived id plus the validated record. */
export interface ScannedWorkflowDeployment {
  /** The `workflow-runs/<deploymentId>` directory name the record was found under. */
  deploymentId: string;
  record: WorkflowDeploymentRecord;
}

/**
 * Enumerate the persisted deployment records under `workflow-runs/` so a
 * boot-time restore can re-establish each deployment. Soft-fails per record:
 * a missing `deployment.json`, unparseable JSON, or a record that fails schema
 * validation is logged and skipped rather than wedging the whole boot -- one
 * corrupt record must not strand every other deployment. An absent
 * `workflow-runs/` directory is the legitimate first-boot case and yields an
 * empty list, not an error.
 *
 * The returned `deploymentId` is the directory name; the caller cross-checks it
 * against the record's own address before trusting it.
 */
export async function scanWorkflowDeploymentRecords(
  dataDir: string,
): Promise<ScannedWorkflowDeployment[]> {
  const runsDir = pathJoin(dataDir, "workflow-runs");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (cause) {
    if (isErrnoNotFound(cause)) return [];
    throw cause;
  }

  const scanned: ScannedWorkflowDeployment[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const deploymentId = entry.name;
    const path = recordPath(dataDir, deploymentId);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      // A run directory with no record: a crash between mkdir and the record
      // write, or a run whose record was already reclaimed. Nothing to
      // restore from -- skip.
      if (isErrnoNotFound(cause)) {
        logger.warn`skipping workflow-runs/${deploymentId}: no ${RECORD_FILENAME} to restore from`;
        continue;
      }
      throw cause;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn`skipping workflow-runs/${deploymentId}: ${RECORD_FILENAME} is not valid JSON: ${reason}`;
      continue;
    }

    const record = WorkflowDeploymentRecord(parsed);
    if (record instanceof type.errors) {
      logger.warn`skipping workflow-runs/${deploymentId}: ${RECORD_FILENAME} failed validation: ${record.summary}`;
      continue;
    }
    scanned.push({ deploymentId, record });
  }
  return scanned;
}
