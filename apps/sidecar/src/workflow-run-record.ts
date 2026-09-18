// Sidecar-local persistence to re-establish a workflow run across a sidecar
// process restart, co-located with the run's substrate so one teardown
// reclaims both. Carries the inputs that are otherwise frame/in-memory only
// (sources, sessionId, hubPublicKey, approvedWireHash, sourceRef); the
// definition and each step's grants are re-materialized elsewhere on restore.

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join as pathJoin } from "node:path";

import { type } from "arktype";

import { getLogger } from "@intx/log";
import { credentialAad, type CredentialCipher } from "@intx/types";
import { InferenceSource } from "@intx/types/runtime";
import { CredentialDelivery, SourceRefPin } from "@intx/types/sidecar";

import { writeFileAtomicDurable } from "./atomic-write";

const logger = getLogger(["interchange", "sidecar", "workflow-run-record"]);

const RECORD_FILENAME = "deployment.json";

/** True for a `node:fs` rejection whose `code` is `ENOENT`. */
function isENOENT(cause: unknown): boolean {
  return (
    cause instanceof Error && "code" in cause && (cause as { code: unknown }).code === "ENOENT"
  );
}

// version 2 unifies credentials: sources/bodySources reference a
// credentialId, and secrets live once in the credentials cell, sealed under
// the sidecar cipher. A pre-unification record is soft-skipped at scan; the
// hub re-pushes its deployment on reconnect.
const workflowRunRecordBase = {
  version: "1 | 2",
  agentAddress: "string > 0",
  definitionId: "string > 0",
  // Non-secret: each source carries a credentialId into credentials.
  sources: {
    "[string]": InferenceSource.array().atLeastLength(1),
  },
  // Keyed by spawned-body definition id; a nested loop body folds into its
  // container's table instead of a separate entry.
  "bodySources?": {
    "[string]": {
      "[string]": InferenceSource.array().atLeastLength(1),
    },
  },
  // The one at-rest home for every secret; only each material's secret is
  // sealed under the sidecar cipher (see transformDeliveryMaterials).
  "credentials?": CredentialDelivery,
  "sessionId?": "string > 0",
  "hubPublicKey?": "string > 0",
} as const;

/**
 * Requires sourceRef and approvedWireHash so the restored child re-verifies
 * against the hub-approved pin rather than a sidecar recompute — a record
 * missing either (including a legacy live-authored one) soft-skips as
 * corruption at scan, needing no bespoke source-ref guard.
 */
export const WorkflowRunRecord = type({
  ...workflowRunRecordBase,
  lineage: "'source-ref'",
  approvedWireHash: "string > 0",
  // Re-run through applyFrozenWorkflowClosure on restore; plain strings, no secrets.
  sourceRef: SourceRefPin,
});
export type WorkflowRunRecord = typeof WorkflowRunRecord.infer;

function recordPath(dataDir: string, runId: string): string {
  return pathJoin(dataDir, "workflow-runs", runId, RECORD_FILENAME);
}

// Binds a sealed secret to its id, so a ciphertext cannot be swapped between credentials or runs and still decrypt.
function credentialSecretColumn(credentialId: string): string {
  return `credential:${credentialId}:secret`;
}

// Returns a fresh delivery; a decrypt failure throws and the scan caller
// treats it as corruption, soft-skipping the whole run.
async function transformDeliveryMaterials(
  delivery: CredentialDelivery,
  runId: string,
  transform: (secret: string, aad: string) => Promise<string>,
): Promise<CredentialDelivery> {
  return {
    bindings: delivery.bindings,
    materials: await Promise.all(
      delivery.materials.map(async (material) => ({
        ...material,
        secret: await transform(
          material.secret,
          credentialAad(runId, credentialSecretColumn(material.credentialId)),
        ),
      })),
    ),
  };
}

/**
 * Written after the run's slug is claimed and before the child spawns, so a
 * crash mid-spawn leaves a record the boot scan re-drives. Idempotent.
 * Every credential secret is sealed under the sidecar cipher before disk.
 */
export async function writeWorkflowRunRecord(
  dataDir: string,
  runId: string,
  record: WorkflowRunRecord,
  cipher: CredentialCipher,
): Promise<void> {
  const path = recordPath(dataDir, runId);
  await mkdir(dirname(path), { recursive: true });
  const sealed: WorkflowRunRecord = {
    ...record,
    version: 2,
    ...(record.credentials !== undefined
      ? {
          credentials: await transformDeliveryMaterials(record.credentials, runId, (secret, aad) =>
            cipher.encrypt(secret, aad),
          ),
        }
      : {}),
  };
  // Atomic + durable since this is the sole restore source; owner-only since
  // the record still names each source's provider/baseURL in the clear.
  await writeFileAtomicDurable(path, JSON.stringify(sealed, null, 2), {
    mode: 0o600,
  });
}

/**
 * Remove a run record. Called on undeploy and on a soft-failed deploy so a
 * torn-down or never-completed run is not restored on the next boot. A
 * missing record is not an error (`force`).
 */
export async function deleteWorkflowRunRecord(dataDir: string, runId: string): Promise<void> {
  await rm(recordPath(dataDir, runId), { force: true });
}

/** A restorable run: its directory-derived id plus the validated record. */
export interface ScannedWorkflowRun {
  /** The `workflow-runs/<runId>` directory name the record was found under. */
  runId: string;
  record: WorkflowRunRecord;
}

/**
 * Soft-fails per record so one corrupt record doesn't strand every other
 * run; an absent workflow-runs/ directory is the legitimate first-boot case.
 */
export async function scanWorkflowRunRecords(
  dataDir: string,
  cipher: CredentialCipher,
): Promise<ScannedWorkflowRun[]> {
  const runsDir = pathJoin(dataDir, "workflow-runs");
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (cause) {
    if (isENOENT(cause)) return [];
    throw cause;
  }

  const scanned: ScannedWorkflowRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runId = entry.name;
    const path = recordPath(dataDir, runId);

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      // A run directory with no record: a crash between mkdir and the record
      // write, or a run whose record was already reclaimed. Nothing to
      // restore from -- skip.
      if (isENOENT(cause)) {
        logger.warn`skipping workflow-runs/${runId}: no ${RECORD_FILENAME} to restore from`;
        continue;
      }
      throw cause;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      logger.warn`skipping workflow-runs/${runId}: ${RECORD_FILENAME} is not valid JSON: ${reason}`;
      continue;
    }

    const record = WorkflowRunRecord(parsed);
    if (record instanceof type.errors) {
      logger.warn`skipping workflow-runs/${runId}: ${RECORD_FILENAME} failed validation: ${record.summary}`;
      continue;
    }
    // A decrypt failure is treated as corruption: soft-skip the whole run
    // rather than wedge the boot scan.
    let restored = record;
    if (record.version === 2 && record.credentials !== undefined) {
      try {
        restored = {
          ...record,
          credentials: await transformDeliveryMaterials(record.credentials, runId, (secret, aad) =>
            cipher.decrypt(secret, aad),
          ),
        };
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        logger.warn`skipping workflow-runs/${runId}: sealed credential decrypt failed: ${reason}`;
        continue;
      }
    }
    scanned.push({ runId, record: restored });
  }
  return scanned;
}
