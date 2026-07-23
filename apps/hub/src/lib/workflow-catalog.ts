import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import {
  type EmbeddedDisplayFlowStep,
  EmbeddedWorkflowDefSchema,
  embeddedWorkflowDefsDir,
} from "./workflow-defs-embedded";
import {
  deriveEntryStepRequiredTriggerFields,
  type EmbeddedIntakeField,
  type WorkflowGateInfo,
} from "./workflow-gate-info";

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

async function readEmbeddedDefs(
  defsDir: string,
): Promise<(typeof EmbeddedWorkflowDefSchema.infer)[]> {
  const defs: (typeof EmbeddedWorkflowDefSchema.infer)[] = [];
  let files: string[];
  try {
    files = (await readdir(defsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return defs;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(defsDir, file), "utf8"));
      const parsed = EmbeddedWorkflowDefSchema(raw);
      if (!(parsed instanceof type.errors)) defs.push(parsed);
    } catch {
      // Skip an unreadable/malformed committed def; each kind has its own file.
    }
  }
  return defs;
}

// The gate shape (requiresIntake + humanGateCount) per kind, read from the
// committed embedded catalog (CL-3508). The scheduling layer uses these to decide
// which kinds are attachable to a brief. A kind with no committed def, or a
// malformed file, is simply absent — the caller treats an absent kind as
// not-attachable.
export async function loadWorkflowGateInfos(
  defsDir: string = embeddedWorkflowDefsDir(),
): Promise<Map<string, WorkflowGateInfo>> {
  const infos = new Map<string, WorkflowGateInfo>();
  for (const def of await readEmbeddedDefs(defsDir)) {
    if (def.requiresIntake === undefined || def.humanGateCount === undefined) {
      continue;
    }
    infos.set(def.kind, {
      requiresIntake: def.requiresIntake,
      humanGateCount: def.humanGateCount,
      ...(def.allowsScheduledPostIntakeDrive !== undefined
        ? { allowsScheduledPostIntakeDrive: def.allowsScheduledPostIntakeDrive }
        : {}),
    });
  }
  return infos;
}

// The trigger-payload fields each kind's entry step requires directly (CL-4204
// routine eligibility derivation), read from the committed embedded catalog's
// `definition`. Used alongside declared intake fields and the trigger-payload-
// enricher registry to decide whether a kind can actually run unattended from
// a schedule's stored intake — see `@workbench/shared`'s `isRoutineEligibleKind`.
export async function loadWorkflowEntryTriggerFields(
  defsDir: string = embeddedWorkflowDefsDir(),
): Promise<Map<string, string[]>> {
  const fields = new Map<string, string[]>();
  for (const def of await readEmbeddedDefs(defsDir)) {
    fields.set(def.kind, deriveEntryStepRequiredTriggerFields(def.definition));
  }
  return fields;
}

// The first-intake form fields per kind, read from the committed embedded catalog
// (CL-3509), so the attach UI can collect a workflow's intake payload without
// importing workflow code. A kind that declares none is absent from the map.
export async function loadWorkflowIntakeFields(
  defsDir: string = embeddedWorkflowDefsDir(),
): Promise<Map<string, EmbeddedIntakeField[]>> {
  const fields = new Map<string, EmbeddedIntakeField[]>();
  for (const def of await readEmbeddedDefs(defsDir)) {
    if (def.intakeFields !== undefined) fields.set(def.kind, def.intakeFields);
  }
  return fields;
}
