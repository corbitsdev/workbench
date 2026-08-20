import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  markWorkflowDeploymentRecordParked,
  readWorkflowDeploymentRecord,
  scanWorkflowDeploymentRecords,
  writeWorkflowDeploymentRecord,
  type WorkflowDeploymentRecord,
} from "./workflow-deployment-record";

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
