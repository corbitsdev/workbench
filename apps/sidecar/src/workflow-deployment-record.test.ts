import { describe, test, expect } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type } from "arktype";

import {
  WorkflowDeploymentRecord,
  writeWorkflowDeploymentRecord,
  writeDeploymentTombstone,
  writeDeploymentDormantMarker,
  clearDeploymentDormantMarker,
  deleteWorkflowDeploymentRecord,
  reclaimWorkflowDeploymentDir,
  workflowDeploymentDir,
  scanWorkflowDeploymentRecords,
} from "./workflow-deployment-record";

async function makeDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "wdr-"));
}

function recordPath(dataDir: string, deploymentId: string): string {
  return path.join(dataDir, "workflow-runs", deploymentId, "deployment.json");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const SINGLE_STEP: WorkflowDeploymentRecord = {
  version: 1,
  agentAddress: "ins_abc123@tenant.example",
  definitionId: "wf_abc123",
  tenantId: "ten_abc",
  rawDeploymentId: "ses_abc123",
  singleAgentId: "agt_abc",
  singleAgentPrincipalId: "prn_abc",
  sources: {
    "step-1": [
      {
        id: "anthropic:mock",
        provider: "anthropic",
        baseURL: "https://api.example/anthropic",
        apiKey: "sk-x",
        model: "claude-mock",
      },
    ],
  },
  sessionId: "ses_1",
  hubPublicKey: "deadbeef",
};

// A multi-step deployment records no head hub key and may carry no session
// id -- both optional fields absent.
const MULTI_STEP: WorkflowDeploymentRecord = {
  version: 1,
  agentAddress: "ins_dep_xyz@tenant.example",
  definitionId: "wf_xyz",
  tenantId: "ten_xyz",
  rawDeploymentId: "ses_dep_xyz",
  singleAgentId: "agt_xyz",
  singleAgentPrincipalId: "prn_xyz",
  sources: {
    plan: [
      {
        id: "anthropic:mock",
        provider: "anthropic",
        baseURL: "https://api.example/anthropic",
        apiKey: "sk-y",
        model: "claude-mock",
      },
    ],
    execute: [
      {
        id: "openai:mock",
        provider: "openai",
        baseURL: "https://api.example/openai",
        apiKey: "sk-z",
        model: "gpt-mock",
      },
    ],
  },
};

describe("workflow deployment record store", () => {
  test("round-trips a schema-valid record through disk (single-step)", async () => {
    const dataDir = await makeDataDir();
    const deploymentId = "abc123-tenant-example";
    await writeWorkflowDeploymentRecord(dataDir, deploymentId, SINGLE_STEP);

    // The record embeds source apiKeys, so it must not be group/world
    // readable on a shared host.
    const stat = await fs.stat(recordPath(dataDir, deploymentId));
    expect(stat.mode & 0o077).toBe(0);

    const raw = await fs.readFile(recordPath(dataDir, deploymentId), "utf8");
    const parsed = WorkflowDeploymentRecord(JSON.parse(raw));
    if (parsed instanceof type.errors) {
      throw new Error(`record failed validation: ${parsed.summary}`);
    }
    expect(parsed).toEqual(SINGLE_STEP);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("round-trips a record with the optional fields absent (multi-step)", async () => {
    const dataDir = await makeDataDir();
    const deploymentId = "dep_xyz-tenant-example";
    await writeWorkflowDeploymentRecord(dataDir, deploymentId, MULTI_STEP);

    const raw = await fs.readFile(recordPath(dataDir, deploymentId), "utf8");
    const parsed = WorkflowDeploymentRecord(JSON.parse(raw));
    if (parsed instanceof type.errors) {
      throw new Error(`record failed validation: ${parsed.summary}`);
    }
    expect(parsed).toEqual(MULTI_STEP);
    expect("hubPublicKey" in parsed).toBe(false);
    expect("sessionId" in parsed).toBe(false);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("rejects a record missing the CL-2199 tenant/raw-deployment fields", async () => {
    // A record written before the substrate-env threading (or a tampered
    // one) lacks tenantId/rawDeploymentId. It must fail validation so the
    // restore path skips it rather than rebuilding an incomplete substrate
    // env that crashes the workflow-child at boot.
    const { tenantId: _t, rawDeploymentId: _r, ...withoutIds } = SINGLE_STEP;
    const parsed = WorkflowDeploymentRecord(withoutIds);
    expect(parsed instanceof type.errors).toBe(true);
  });

  test("overwriting a record leaves the new one and no temp orphan", async () => {
    const dataDir = await makeDataDir();
    const deploymentId = "rotated-1";

    // A source rotation overwrites the existing record in place. The
    // atomic write must replace it cleanly, leaving only the record and
    // no `.tmp` staging file behind.
    await writeWorkflowDeploymentRecord(dataDir, deploymentId, SINGLE_STEP);
    await writeWorkflowDeploymentRecord(dataDir, deploymentId, MULTI_STEP);

    const dir = path.join(dataDir, "workflow-runs", deploymentId);
    expect(await fs.readdir(dir)).toEqual(["deployment.json"]);

    const scanned = await scanWorkflowDeploymentRecords(dataDir);
    expect(scanned.map((s) => s.record)).toEqual([MULTI_STEP]);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("delete removes the record and is a no-op when absent", async () => {
    const dataDir = await makeDataDir();
    const deploymentId = "gone-1";

    // No-op when the record was never written.
    await deleteWorkflowDeploymentRecord(dataDir, deploymentId);

    await writeWorkflowDeploymentRecord(dataDir, deploymentId, SINGLE_STEP);
    expect(await fileExists(recordPath(dataDir, deploymentId))).toBe(true);

    await deleteWorkflowDeploymentRecord(dataDir, deploymentId);
    expect(await fileExists(recordPath(dataDir, deploymentId))).toBe(false);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("reclaimWorkflowDeploymentDir removes the record, tombstone, and co-located run state (CL-3368)", async () => {
    const dataDir = await makeDataDir();
    const deploymentId = "reclaim-whole-1";

    await writeWorkflowDeploymentRecord(dataDir, deploymentId, SINGLE_STEP);
    await writeDeploymentTombstone(dataDir, deploymentId);
    const dir = workflowDeploymentDir(dataDir, deploymentId);
    await fs.writeFile(path.join(dir, "run-state"), "x", "utf8");

    expect(await fileExists(dir)).toBe(true);

    await reclaimWorkflowDeploymentDir(dataDir, deploymentId);

    // The whole directory is gone -- not just deployment.json, which is all
    // deleteWorkflowDeploymentRecord would have removed.
    expect(await fileExists(dir)).toBe(false);

    // Idempotent: a second reclaim of an absent dir does not throw.
    await reclaimWorkflowDeploymentDir(dataDir, deploymentId);

    await fs.rm(dataDir, { recursive: true, force: true });
  });
});

describe("scanWorkflowDeploymentRecords", () => {
  test("returns an empty list when the workflow-runs directory is absent", async () => {
    const dataDir = await makeDataDir();
    // First boot: nothing has been deployed, so `workflow-runs/` does not
    // exist. That is the legitimate empty case, not an error.
    expect(await scanWorkflowDeploymentRecords(dataDir)).toEqual([]);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("returns every schema-valid record keyed by its directory name", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep-a", SINGLE_STEP);
    await writeWorkflowDeploymentRecord(dataDir, "dep-b", MULTI_STEP);

    const scanned = await scanWorkflowDeploymentRecords(dataDir);
    const byId = new Map(scanned.map((s) => [s.deploymentId, s.record]));
    expect(byId.size).toBe(2);
    expect(byId.get("dep-a")).toEqual(SINGLE_STEP);
    expect(byId.get("dep-b")).toEqual(MULTI_STEP);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("CL-3368: skips and reclaims a tombstoned deployment even when its record is still present", async () => {
    const dataDir = await makeDataDir();
    // Simulate an interrupted undeploy: the tombstone was written but the
    // record delete / dir reclaim did not complete (crash between write
    // orders). A boot restore must NOT re-spawn it, and must reclaim the dir.
    await writeWorkflowDeploymentRecord(dataDir, "dep-tombstoned", SINGLE_STEP);
    await writeDeploymentTombstone(dataDir, "dep-tombstoned");
    // A healthy deployment alongside it must still restore.
    await writeWorkflowDeploymentRecord(dataDir, "dep-live", MULTI_STEP);

    const scanned = await scanWorkflowDeploymentRecords(dataDir);
    expect(scanned.map((s) => s.deploymentId)).toEqual(["dep-live"]);
    // The tombstoned deployment's whole dir is reclaimed.
    expect(
      await fileExists(path.join(dataDir, "workflow-runs", "dep-tombstoned")),
    ).toBe(false);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("CL-3368: skips eager restore of a dormant (hibernated) deployment but LEAVES it on disk, while a normal record still restores", async () => {
    const dataDir = await makeDataDir();
    // A hibernated deployment: its record survives (state-preserving teardown)
    // but a dormant marker tells restore not to eager-spawn it — the hub
    // re-drives a fresh deploy on the next gate signal. Unlike a tombstone,
    // its dir MUST survive: the durable run state is the parked run's resume
    // source.
    await writeWorkflowDeploymentRecord(dataDir, "dep-hibernated", SINGLE_STEP);
    await writeDeploymentDormantMarker(dataDir, "dep-hibernated");
    // A normal warm-serving deployment alongside it must still restore.
    await writeWorkflowDeploymentRecord(dataDir, "dep-live", MULTI_STEP);

    const scanned = await scanWorkflowDeploymentRecords(dataDir);
    expect(scanned.map((s) => s.deploymentId)).toEqual(["dep-live"]);

    // The dormant deployment's dir and record are untouched (NOT reclaimed),
    // so a signal-driven wake still has the parked run's state to resume from.
    expect(
      await fileExists(
        path.join(
          dataDir,
          "workflow-runs",
          "dep-hibernated",
          "deployment.json",
        ),
      ),
    ).toBe(true);

    // Clearing the marker (the wake path) restores normal eager behavior.
    await clearDeploymentDormantMarker(dataDir, "dep-hibernated");
    const rescanned = await scanWorkflowDeploymentRecords(dataDir);
    expect(rescanned.map((s) => s.deploymentId).sort()).toEqual([
      "dep-hibernated",
      "dep-live",
    ]);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test("soft-fails a corrupt or schema-invalid record while returning the valid ones", async () => {
    const dataDir = await makeDataDir();
    await writeWorkflowDeploymentRecord(dataDir, "dep-valid", SINGLE_STEP);

    // A directory whose record is not valid JSON.
    const corruptDir = path.join(dataDir, "workflow-runs", "dep-corrupt");
    await fs.mkdir(corruptDir, { recursive: true });
    await fs.writeFile(path.join(corruptDir, "deployment.json"), "{ not json");

    // A directory whose record parses but fails the schema (missing fields).
    const invalidDir = path.join(dataDir, "workflow-runs", "dep-invalid");
    await fs.mkdir(invalidDir, { recursive: true });
    await fs.writeFile(
      path.join(invalidDir, "deployment.json"),
      JSON.stringify({ version: 1 }),
    );

    // A bare run directory with no record at all.
    await fs.mkdir(path.join(dataDir, "workflow-runs", "dep-empty"), {
      recursive: true,
    });

    const scanned = await scanWorkflowDeploymentRecords(dataDir);
    expect(scanned.map((s) => s.deploymentId)).toEqual(["dep-valid"]);
    expect(scanned[0]?.record).toEqual(SINGLE_STEP);

    await fs.rm(dataDir, { recursive: true, force: true });
  });
});
