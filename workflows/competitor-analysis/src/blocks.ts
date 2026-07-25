/**
 * The competitor-analysis workflow's own dock blocks.
 *
 * Gate → block:
 *   intake  → form   (required url + optional companyName / focusNotes)
 *   review  → choice (Approve / Reject; each option carries `{ approved }`).
 *             When the report is decodable it is shown as a markdown preview.
 *
 * Every emitted payload is validated at the /resume boundary by the matching
 * schema in @workbench/shared.
 */
import {
  humanizeStepId,
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import { parseCompetitorReport } from "./parse";
import { INTAKE_FORM_FIELDS } from "./intake-fields";

export const INTAKE_SIGNAL = "intake";
export const REVIEW_SIGNAL = "review";

export interface CompetitorAnalysisBlockInput extends DockRunInput {
  /** Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces. */
  stepOutputs: Record<string, unknown>;
}

// The dock's intake fields (CL-4538) — the SAME list `./intake-fields.ts`
// derives the schedule/attach `INTAKE_FIELDS` from, so the two surfaces can
// never disagree about which fields exist or which are required. Converted
// to `FormField` here (rather than in `./intake-fields.ts`) so that
// dependency-free module never needs a runtime edge onto `@workbench/blocks`.
const INTAKE_BLOCK_FIELDS: readonly FormField[] = INTAKE_FORM_FIELDS.map(
  (field): FormField => {
    if (field.kind !== "text" && field.kind !== "textarea") {
      throw new Error(
        `competitor-analysis intake field "${field.name}" has unsupported kind "${field.kind}"`,
      );
    }
    return {
      kind: field.kind,
      name: field.name,
      ...(field.label !== undefined ? { label: field.label } : {}),
      ...(field.placeholder !== undefined
        ? { placeholder: field.placeholder }
        : {}),
      ...(field.required !== undefined ? { required: field.required } : {}),
    };
  },
);

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

function intakeForm(signalName: string): UIBlock {
  return {
    kind: "form",
    prompt:
      "Enter the company to research. We scrape their site, search for alternatives, and draft a competitor shortlist for you to review.",
    signalName,
    submitLabel: "Find competitors",
    fields: [...INTAKE_BLOCK_FIELDS],
  };
}

function reviewChoice(signalName: string): UIBlock {
  return {
    kind: "choice",
    prompt:
      "Approve the competitor report to save it, or reject to discard it.",
    signalName,
    options: [
      {
        id: "approve",
        label: "Approve & save",
        payload: { approved: true },
      },
      {
        id: "reject",
        label: "Reject",
        payload: { approved: false },
      },
    ],
  };
}

export function buildCompetitorAnalysisBlocks(
  input: CompetitorAnalysisBlockInput,
): UIBlock[] {
  const blocks: UIBlock[] = [];

  if (input.steps.length > 0) {
    const steps: ProgressStep[] = input.steps.map((step) => ({
      state: progressStateForStepPhase(step.phase),
      label: humanizeStepId(step.stepId),
    }));
    blocks.push({ kind: "progress", steps });
  }

  const gate = pendingGateForRun({ runId: input.runId, steps: input.steps });
  if (gate !== null) {
    blocks.push(...gateBlocks(gate.signalName, input));
  }

  if (input.phase === "failed" && input.errorMessage !== undefined) {
    blocks.push({ kind: "error", message: input.errorMessage });
  }

  if (input.phase === "completed" && input.completedLink !== undefined) {
    blocks.push({
      kind: "link",
      url: input.completedLink.url,
      title: input.completedLink.title,
      ...(input.completedLink.description !== undefined
        ? { description: input.completedLink.description }
        : {}),
    });
  }

  return blocks;
}

function gateBlocks(
  signalName: string,
  input: CompetitorAnalysisBlockInput,
): UIBlock[] {
  if (signalName === INTAKE_SIGNAL) {
    return [intakeForm(signalName)];
  }

  if (signalName === REVIEW_SIGNAL) {
    const report = parseCompetitorReport(input.stepOutputs.synthesize);
    if (report.status === "ok") {
      return [
        {
          kind: "markdown",
          title: report.value.title,
          source: report.value.content,
          collapsible: true,
        },
        reviewChoice(signalName),
      ];
    }
    return [reviewChoice(signalName)];
  }

  return [
    runPageLink(
      input.runId,
      "Continue on the run page",
      "This run needs input the dock can't collect yet — continue on the run page.",
    ),
  ];
}
