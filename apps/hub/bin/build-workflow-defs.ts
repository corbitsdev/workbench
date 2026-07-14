// Serialize every workflow definition to a static JSON under
// `apps/hub/generated/workflow-defs/<kind>.json` at build time (CL-2593). The
// hub bundles these committed files (the image carries no workflow source) and
// publishes them to the registry on boot. A non-serializable / invalid def
// makes this script exit nonzero — it is the CI gate that keeps a broken def
// from ever reaching boot. Run via `bun run build:workflow-defs`.

import { existsSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type } from "arktype";
import { loadWorkflow, readWorkflowMeta } from "./deploy-workflow";
import {
  EmbeddedWorkflowDefSchema,
  embeddedWorkflowDefsDir,
} from "../src/lib/workflow-defs-embedded";
import { deriveWorkflowGateInfo } from "../src/lib/workflow-gate-info";

function repoRoot(): string {
  const binDir = dirname(fileURLToPath(import.meta.url));
  return dirname(dirname(dirname(binDir)));
}

export function workflowKinds(): string[] {
  const dir = join(repoRoot(), "workflows");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(dir, name, "package.json")))
    .sort();
}

// Serialize one workflow's exported `workflow` definition to the validated
// embedded shape (no file I/O). Exported so the drift test can compare the
// live source against the committed JSON without invoking the writer.
export async function serializeWorkflowDef(
  kind: string,
): Promise<typeof EmbeddedWorkflowDefSchema.infer> {
  const { definition, label, description, displayFlow, intakeFields } =
    await loadWorkflow(kind);
  const { requiresIntake, humanGateCount } = deriveWorkflowGateInfo(definition);
  const embedded = {
    kind,
    version: readWorkflowMeta(kind).version,
    ...(label !== undefined ? { label } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(displayFlow !== undefined ? { displayFlow } : {}),
    requiresIntake,
    humanGateCount,
    ...(intakeFields !== undefined ? { intakeFields } : {}),
    definition,
  };
  // Validate the serialized shape the hub will parse on boot — a malformed
  // definition fails the build here rather than at boot.
  const parsed = EmbeddedWorkflowDefSchema(embedded);
  if (parsed instanceof type.errors) {
    throw new Error(
      `build-workflow-defs: ${kind} produced an invalid embedded def: ${parsed.summary}`,
    );
  }
  return parsed;
}

// The on-disk serialization of an embedded def — the single source of truth for
// both the writer and the drift test, so they can never disagree on format.
export function serializeEmbeddedJson(
  embedded: typeof EmbeddedWorkflowDefSchema.infer,
): string {
  return JSON.stringify(embedded, null, 2) + "\n";
}

async function main(): Promise<void> {
  const kinds = workflowKinds();
  const outDir = embeddedWorkflowDefsDir();
  mkdirSync(outDir, { recursive: true });
  for (const kind of kinds) {
    const embedded = await serializeWorkflowDef(kind);
    writeFileSync(
      join(outDir, `${kind}.json`),
      serializeEmbeddedJson(embedded),
      "utf8",
    );
    process.stdout.write(`serialized ${kind}\n`);
  }
  process.stdout.write(`build-workflow-defs: wrote ${kinds.length} defs\n`);
}

// Only run the writer when executed directly (so tests can import the helpers
// above without serializing to disk).
if (import.meta.main) {
  await main();
}
