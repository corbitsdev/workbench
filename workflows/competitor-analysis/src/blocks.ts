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
  pendingGateForRun,
  progressStateForStepPhase,
  type DockRunInput,
  type FormField,
  type ProgressStep,
  type UIBlock,
} from "@workbench/blocks";
import { parseCompetitorReport } from "./parse";

export const INTAKE_SIGNAL = "intake";
export const REVIEW_SIGNAL = "review";

export interface CompetitorAnalysisBlockInput extends DockRunInput {
  /** Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces. */
  stepOutputs: Record<string, unknown>;
}

function humanizeStepId(stepId: string): string {
  return stepId.replace(/[-_]+/gu, " ").trim();
}

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

function intakeForm(signalName: string): UIBlock {
  // Named `url` (not `companyUrl`): must equal the shared `firecrawl_scrape`
  // tool's arg verbatim — native `action` selectors cannot rename a key
  // (CL-4454). See CompetitorAnalysisIntakePayloadSchema.
  const companyUrl: FormField = {
    kind: "text",
    name: "url",
    label: "Company website URL",
    placeholder: "https://acme.com",
    required: true,
  };
  const companyName: FormField = {
    kind: "text",
    name: "companyName",
    label: "Company name (optional)",
    placeholder: "Acme",
    required: false,
  };
  const focusNotes: FormField = {
    kind: "textarea",
    name: "focusNotes",
    label: "Focus notes (optional)",
    placeholder: "e.g. mid-market CRM, EU region, product-led motion",
    required: false,
  };
  return {
    kind: "form",
    prompt:
      "Enter the company to research. We scrape their site, search for alternatives, and draft a competitor shortlist for you to review.",
    signalName,
    submitLabel: "Find competitors",
    fields: [companyUrl, companyName, focusNotes],
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
