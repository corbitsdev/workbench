import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  findWorkflowDefsDrift,
  renderDriftReport,
} from "./check-workflow-defs-drift";

const CLEAN = new Map([
  ["alpha", '{\n  "kind": "alpha"\n}\n'],
  ["beta", '{\n  "kind": "beta"\n}\n'],
]);

describe("findWorkflowDefsDrift", () => {
  test("reports no drift when every committed def matches the live serialization", () => {
    const result = findWorkflowDefsDrift(CLEAN, CLEAN);
    expect(result.hasDrift).toBe(false);
    expect(result.staleKinds).toEqual([]);
    expect(result.missingKinds).toEqual([]);
    expect(result.orphanKinds).toEqual([]);
  });

  test("reports a stale kind when committed content differs from live", () => {
    const committed = new Map(CLEAN);
    committed.set("alpha", '{\n  "kind": "alpha",\n  "stale": true\n}\n');
    const result = findWorkflowDefsDrift(CLEAN, committed);
    expect(result.hasDrift).toBe(true);
    expect(result.staleKinds).toEqual(["alpha"]);
    const report = renderDriftReport(result);
    expect(report).toContain("alpha.json");
    expect(report).toContain("bun run build:workflow-defs");
  });

  test("reports a missing kind when a workflow has no committed def", () => {
    const committed = new Map(CLEAN);
    committed.delete("beta");
    const result = findWorkflowDefsDrift(CLEAN, committed);
    expect(result.hasDrift).toBe(true);
    expect(result.missingKinds).toEqual(["beta"]);
    expect(renderDriftReport(result)).toContain("beta.json");
  });

  test("reports an orphan when a committed def has no matching workflow", () => {
    const committed = new Map(CLEAN);
    committed.set("gone", '{\n  "kind": "gone"\n}\n');
    const result = findWorkflowDefsDrift(CLEAN, committed);
    expect(result.hasDrift).toBe(true);
    expect(result.orphanKinds).toEqual(["gone"]);
    expect(renderDriftReport(result)).toContain("gone.json");
  });
});

describe("check-workflow-defs-drift script against the real repo", () => {
  // serializeWorkflowDef dynamically imports every workflow package on first
  // invocation in a process, which blows past bun's default 5000ms timeout.
  test("the committed workflow defs match the live workflow sources", async () => {
    const { workflowKinds, serializeWorkflowDef, serializeEmbeddedJson } =
      await import("./build-workflow-defs");
    const { embeddedWorkflowDefsDir } = await import(
      "../src/lib/workflow-defs-embedded"
    );
    const live = new Map<string, string>();
    for (const kind of workflowKinds()) {
      live.set(kind, serializeEmbeddedJson(await serializeWorkflowDef(kind)));
    }
    const committed = new Map<string, string>();
    const dir = embeddedWorkflowDefsDir();
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      committed.set(
        file.slice(0, -".json".length),
        await readFile(join(dir, file), "utf8"),
      );
    }
    const result = findWorkflowDefsDrift(live, committed);
    expect(result.staleKinds).toEqual([]);
    expect(result.missingKinds).toEqual([]);
    expect(result.orphanKinds).toEqual([]);
    expect(result.hasDrift).toBe(false);
  }, 60_000);
});
