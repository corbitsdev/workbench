import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import {
  type EmbeddedDisplayFlowStep,
  EmbeddedWorkflowDefSchema,
  embeddedWorkflowDefsDir,
} from "./workflow-defs-embedded";

/**
 * The authoritative set of REAL workflow kinds the workbench can run: the
 * `kind` of every serialized definition committed under
 * `apps/hub/generated/workflow-defs/*.json` (the build-time embedded catalog,
 * CL-2593). This is the allowlist the admin Definitions browser filters the
 * `workflow_run` deployment index against, so junk rows written by unvalidated
 * direct deploys — a bare workflow STEP (`skipWriteBack`, `source`), a per-run
 * supervisor (`supervisor-ses_…`) — never surface as if they were a workflow
 * definition (CL-2807). A malformed catalog file is skipped rather than
 * poisoning the whole allowlist.
 */
export async function loadWorkflowCatalogKinds(
  defsDir: string = embeddedWorkflowDefsDir(),
): Promise<Set<string>> {
  const kinds = new Set<string>();
  let files: string[];
  try {
    files = (await readdir(defsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return kinds;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(defsDir, file), "utf8"));
      const parsed = EmbeddedWorkflowDefSchema(raw);
      if (!(parsed instanceof type.errors)) {
        kinds.add(parsed.kind);
      }
    } catch {
      // Skip an unreadable/malformed committed def; a real kind is never lost
      // because each kind has its own file.
    }
  }
  return kinds;
}

/**
 * The declared user-facing display flow for each workflow kind that ships one,
 * read from the committed embedded catalog (`generated/workflow-defs/*.json`).
 * This is how the server catalog preview obtains a workflow's DISPLAY_STEPS
 * without importing workflow runtime code: the flow is serialized alongside the
 * def at build time and travels in the same committed artifact as `label` /
 * `description`. A kind with no declared flow is simply absent from the map, and
 * the classifier falls back to the per-step `stepOrder` projection. A malformed
 * file is skipped rather than dropping every kind.
 */
export async function loadWorkflowDisplayFlows(
  defsDir: string = embeddedWorkflowDefsDir(),
): Promise<Map<string, EmbeddedDisplayFlowStep[]>> {
  const flows = new Map<string, EmbeddedDisplayFlowStep[]>();
  let files: string[];
  try {
    files = (await readdir(defsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return flows;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(defsDir, file), "utf8"));
      const parsed = EmbeddedWorkflowDefSchema(raw);
      if (
        !(parsed instanceof type.errors) &&
        parsed.displayFlow !== undefined
      ) {
        flows.set(parsed.kind, parsed.displayFlow);
      }
    } catch {
      // Skip an unreadable/malformed committed def.
    }
  }
  return flows;
}
