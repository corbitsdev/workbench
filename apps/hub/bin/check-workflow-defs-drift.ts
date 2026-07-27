// Fail-fast guard: every committed `apps/hub/generated/workflow-defs/<kind>.json`
// must match what `bun run build:workflow-defs` would serialize from the live
// workflow sources right now. The committed defs are read at runtime outside
// the Docker image build (local bootstrap, catalog routes), so a stale def
// silently ships behaviour its workflow source no longer has — CL-4649 traces
// one such incident. Wired into `bun run lint:all` (root package.json) and the
// hub Dockerfile, the same way check-tool-manifest-drift guards its index.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  serializeEmbeddedJson,
  serializeWorkflowDef,
  workflowKinds,
} from "./build-workflow-defs";
import { embeddedWorkflowDefsDir } from "../src/lib/workflow-defs-embedded";

export interface WorkflowDefsDriftResult {
  hasDrift: boolean;
  staleKinds: string[];
  missingKinds: string[];
  orphanKinds: string[];
}

export function findWorkflowDefsDrift(
  live: ReadonlyMap<string, string>,
  committed: ReadonlyMap<string, string>,
): WorkflowDefsDriftResult {
  const staleKinds: string[] = [];
  const missingKinds: string[] = [];
  for (const [kind, liveJson] of [...live].sort()) {
    const committedJson = committed.get(kind);
    if (committedJson === undefined) {
      missingKinds.push(kind);
    } else if (committedJson !== liveJson) {
      staleKinds.push(kind);
    }
  }
  const orphanKinds = [...committed.keys()]
    .filter((kind) => !live.has(kind))
    .sort();
  return {
    hasDrift:
      staleKinds.length > 0 ||
      missingKinds.length > 0 ||
      orphanKinds.length > 0,
    staleKinds,
    missingKinds,
    orphanKinds,
  };
}

export function renderDriftReport(result: WorkflowDefsDriftResult): string {
  const lines = [
    "check-workflow-defs-drift: the committed workflow defs do not match the",
    "live workflow sources.",
    "",
  ];
  for (const kind of result.staleKinds) {
    lines.push(`Stale: apps/hub/generated/workflow-defs/${kind}.json`);
  }
  for (const kind of result.missingKinds) {
    lines.push(`Missing: apps/hub/generated/workflow-defs/${kind}.json`);
  }
  for (const kind of result.orphanKinds) {
    lines.push(
      `Orphan (no workflows/${kind}): apps/hub/generated/workflow-defs/${kind}.json`,
    );
  }
  lines.push(
    "",
    "Fix: run `bun run build:workflow-defs` in apps/hub and commit the",
    "regenerated apps/hub/generated/workflow-defs/ files (delete orphans).",
  );
  return lines.join("\n");
}

async function collectLiveDefs(): Promise<Map<string, string>> {
  const live = new Map<string, string>();
  for (const kind of workflowKinds()) {
    live.set(kind, serializeEmbeddedJson(await serializeWorkflowDef(kind)));
  }
  return live;
}

function collectCommittedDefs(): Map<string, string> {
  const dir = embeddedWorkflowDefsDir();
  const committed = new Map<string, string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    committed.set(
      file.slice(0, -".json".length),
      readFileSync(join(dir, file), "utf8"),
    );
  }
  return committed;
}

async function main(): Promise<void> {
  const result = findWorkflowDefsDrift(
    await collectLiveDefs(),
    collectCommittedDefs(),
  );
  if (result.hasDrift) {
    process.stderr.write(renderDriftReport(result) + "\n");
    process.exit(1);
  }
  process.stdout.write(
    `check-workflow-defs-drift: ok (${workflowKinds().length} defs)\n`,
  );
}

if (import.meta.main) {
  await main();
}
