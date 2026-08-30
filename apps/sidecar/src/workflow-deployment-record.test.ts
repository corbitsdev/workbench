import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RESTORE_QUARANTINE_THRESHOLD,
  clearWorkflowDeploymentRestoreFailure,
  isWorkflowDeploymentRestoreQuarantined,
  markWorkflowDeploymentRecordParked,
  partitionScannedDeployments,
  readWorkflowDeploymentRecord,
  recordWorkflowDeploymentRestoreFailure,
  scanWorkflowDeploymentRecords,
  writeWorkflowDeploymentRecord,
  type WorkflowDeploymentRecord,
} from "./workflow-deployment-record";

const RECORD_FILENAME = "deployment.json";

function recordPath(dataDir: string, deploymentId: string): string {
  return path.join(dataDir, "workflow-runs", deploymentId, RECORD_FILENAME);
}

async function makeDataDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "deployment-record-test-"));
}

const baseRecord: WorkflowDeploymentRecord = {
  version: 1,
  agentAddress: "run_parked-test@example.com",
  definitionId: "def_1",
  sources: {},
  approvedWireHash: "d".repeat(64),
  sourceRef: {
    source: { kind: "registry", registry: "npm" },
    closure: {
      schemaVersion: "1",
      topLevel: [{ name: "@x/wf", version: "1.0.0" }],
      entries: [],
    },
  },
};

describe("markWorkflowDeploymentRecordParked", () => {
  test("stamps parkedAt on an existing record without disturbing other fields", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_1", baseRecord);

    await markWorkflowDeploymentRecordParked(dataDir, "dep_1");

    const record = await readWorkflowDeploymentRecord(dataDir, "dep_1");
    expect(record?.parkedAt).toBeDefined();
    expect(record?.agentAddress).toBe(baseRecord.agentAddress);
    expect(record?.definitionId).toBe(baseRecord.definitionId);
  });

  test("is a no-op when no record exists for the deployment", async () => {
    const dataDir = await makeDataDir();

    await markWorkflowDeploymentRecordParked(dataDir, "dep_missing");

    await expect(
      readWorkflowDeploymentRecord(dataDir, "dep_missing"),
    ).resolves.toBeUndefined();
  });
});

describe("record backward compatibility", () => {
  test("a record written before the parkedAt field existed still loads as live", async () => {
    const dataDir = await makeDataDir();
    // Simulate a pre-CL-6284 record on disk: no `parkedAt` key at all, not
    // even `parkedAt: undefined`.
    await writeWorkflowDeploymentRecord(dataDir, "dep_legacy", baseRecord);

    const record = await readWorkflowDeploymentRecord(dataDir, "dep_legacy");
    expect(record).toBeDefined();
    expect(record?.parkedAt).toBeUndefined();
  });
});

describe("scanWorkflowDeploymentRecords parked/live distinction", () => {
  test("surfaces parkedAt on scanned records so a caller can tell parked from live", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_live", baseRecord);
    await writeWorkflowDeploymentRecord(dataDir, "dep_parked", baseRecord);
    await markWorkflowDeploymentRecordParked(dataDir, "dep_parked");

    const scanned = await scanWorkflowDeploymentRecords(dataDir);
    const byId = new Map(scanned.map((s) => [s.deploymentId, s.record]));

    expect(byId.get("dep_live")?.parkedAt).toBeUndefined();
    expect(byId.get("dep_parked")?.parkedAt).toBeDefined();
  });
});

describe("scanWorkflowDeploymentRecords reaps pre-cutover records", () => {
  test("an unreadable old-format record (missing approvedWireHash/sourceRef) is reaped once, then boots quietly", async () => {
    const dataDir = await makeDataDir();
    const preCutover = {
      version: 1,
      agentAddress: "run_old-format@example.com",
      definitionId: "def_1",
      sources: {},
    };
    const filePath = recordPath(dataDir, "dep_old");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(preCutover));

    const firstScan = await scanWorkflowDeploymentRecords(dataDir);
    expect(firstScan).toHaveLength(0);
    await expect(fs.access(filePath)).rejects.toThrow();

    // Quiet second boot: the record is already gone, nothing left to reap.
    const secondScan = await scanWorkflowDeploymentRecords(dataDir);
    expect(secondScan).toHaveLength(0);
  });

  test("a parseable record is never reaped", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_live", baseRecord);

    const scanned = await scanWorkflowDeploymentRecords(dataDir);

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.deploymentId).toBe("dep_live");
    await expect(
      readWorkflowDeploymentRecord(dataDir, "dep_live"),
    ).resolves.toBeDefined();
  });

  test("a record invalid for a reason other than the old-format shape is warned about, not reaped", async () => {
    const dataDir = await makeDataDir();
    const corrupt = {
      version: 2, // wrong version -- not the recognized pre-cutover shape
      agentAddress: "run_corrupt@example.com",
      definitionId: "def_1",
      sources: {},
    };
    const filePath = recordPath(dataDir, "dep_corrupt");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(corrupt));

    const scanned = await scanWorkflowDeploymentRecords(dataDir);

    expect(scanned).toHaveLength(0);
    // Still on disk -- never silently eaten.
    await fs.access(filePath);
  });
});

describe("partitionScannedDeployments", () => {
  test("splits scanned records into live (no parkedAt) and parked (parkedAt set)", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_live", baseRecord);
    await writeWorkflowDeploymentRecord(dataDir, "dep_parked", baseRecord);
    await markWorkflowDeploymentRecordParked(dataDir, "dep_parked");
    const scanned = await scanWorkflowDeploymentRecords(dataDir);

    const { live, parked } = partitionScannedDeployments(scanned);

    expect(live.map((s) => s.deploymentId)).toEqual(["dep_live"]);
    expect(parked.map((s) => s.deploymentId)).toEqual(["dep_parked"]);
  });

  test("an all-live scan yields nothing to skip", () => {
    const scanned = [
      { deploymentId: "dep_a", record: baseRecord },
      { deploymentId: "dep_b", record: baseRecord },
    ];

    const { live, parked } = partitionScannedDeployments(scanned);

    expect(live).toHaveLength(2);
    expect(parked).toHaveLength(0);
  });
});

describe("recordWorkflowDeploymentRestoreFailure", () => {
  test("starts a kind's counter at 1 and persists reason/timestamp", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_1", baseRecord);

    const updated = await recordWorkflowDeploymentRestoreFailure(
      dataDir,
      "dep_1",
      { kind: "permanent", reason: "address derives a different slug" },
    );

    expect(updated?.restoreFailure).toEqual({
      kind: "permanent",
      attempts: 1,
      reason: "address derives a different slug",
      lastAttemptAt: updated?.restoreFailure?.lastAttemptAt ?? "",
    });
    const onDisk = await readWorkflowDeploymentRecord(dataDir, "dep_1");
    expect(onDisk?.restoreFailure?.attempts).toBe(1);
  });

  test("increments the counter across repeated failures of the same kind", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_1", baseRecord);

    let record: WorkflowDeploymentRecord | undefined;
    for (let i = 0; i < 3; i++) {
      record = await recordWorkflowDeploymentRestoreFailure(dataDir, "dep_1", {
        kind: "permanent",
        reason: "still malformed",
      });
    }

    expect(record?.restoreFailure?.attempts).toBe(3);
    expect(record?.restoreFailure?.kind).toBe("permanent");
  });

  test("a kind change resets the counter rather than adding to the other kind's count", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_1", baseRecord);

    await recordWorkflowDeploymentRestoreFailure(dataDir, "dep_1", {
      kind: "permanent",
      reason: "malformed",
    });
    let record = await recordWorkflowDeploymentRestoreFailure(
      dataDir,
      "dep_1",
      {
        kind: "permanent",
        reason: "still malformed",
      },
    );
    expect(record?.restoreFailure?.attempts).toBe(2);

    record = await recordWorkflowDeploymentRestoreFailure(dataDir, "dep_1", {
      kind: "transient",
      reason: "provider not registered",
    });

    expect(record?.restoreFailure?.kind).toBe("transient");
    expect(record?.restoreFailure?.attempts).toBe(1);
  });

  test("is a no-op that returns undefined when the record is already gone (CL-7215: a reclaiming teardown raced ahead of this write)", async () => {
    const dataDir = await makeDataDir();
    // Deliberately never written: simulates a teardown deleting the record
    // before the boot loop's failure-recording catch acquires the lock.

    const updated = await recordWorkflowDeploymentRestoreFailure(
      dataDir,
      "dep_missing",
      { kind: "transient", reason: "provider not registered" },
    );

    expect(updated).toBeUndefined();
    const onDisk = await readWorkflowDeploymentRecord(dataDir, "dep_missing");
    expect(onDisk).toBeUndefined();
  });
});

describe("clearWorkflowDeploymentRestoreFailure", () => {
  test("drops restoreFailure after a successful restore", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_1", baseRecord);
    const failed = await recordWorkflowDeploymentRestoreFailure(
      dataDir,
      "dep_1",
      { kind: "transient", reason: "provider not registered" },
    );

    await clearWorkflowDeploymentRestoreFailure(
      dataDir,
      "dep_1",
      failed as WorkflowDeploymentRecord,
    );

    const onDisk = await readWorkflowDeploymentRecord(dataDir, "dep_1");
    expect(onDisk?.restoreFailure).toBeUndefined();
  });

  test("is a no-op when there is no failure to clear", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep_1", baseRecord);

    await clearWorkflowDeploymentRestoreFailure(dataDir, "dep_1", baseRecord);

    const onDisk = await readWorkflowDeploymentRecord(dataDir, "dep_1");
    expect(onDisk?.agentAddress).toBe(baseRecord.agentAddress);
  });
});

describe("isWorkflowDeploymentRestoreQuarantined", () => {
  test("is false below the threshold and true at or above it, for permanent failures only", () => {
    const belowThreshold: WorkflowDeploymentRecord = {
      ...baseRecord,
      restoreFailure: {
        kind: "permanent",
        attempts: RESTORE_QUARANTINE_THRESHOLD - 1,
        reason: "malformed",
        lastAttemptAt: new Date().toISOString(),
      },
    };
    const atThreshold: WorkflowDeploymentRecord = {
      ...baseRecord,
      restoreFailure: {
        kind: "permanent",
        attempts: RESTORE_QUARANTINE_THRESHOLD,
        reason: "malformed",
        lastAttemptAt: new Date().toISOString(),
      },
    };
    const transientAtSameCount: WorkflowDeploymentRecord = {
      ...baseRecord,
      restoreFailure: {
        kind: "transient",
        attempts: RESTORE_QUARANTINE_THRESHOLD + 5,
        reason: "provider not registered",
        lastAttemptAt: new Date().toISOString(),
      },
    };

    expect(isWorkflowDeploymentRestoreQuarantined(belowThreshold)).toBe(false);
    expect(isWorkflowDeploymentRestoreQuarantined(atThreshold)).toBe(true);
    expect(isWorkflowDeploymentRestoreQuarantined(baseRecord)).toBe(false);
    // A transient failure never quarantines, no matter how high its own
    // counter climbs -- it is tracked on a separate counter from the
    // permanent one.
    expect(isWorkflowDeploymentRestoreQuarantined(transientAtSameCount)).toBe(
      false,
    );
  });
});
