/**
 * The sumble-account-intel workflow's own dock blocks.
 *
 * Mirrors the pain-point-collateral / reddit-opportunity-scanner pattern: this
 * builder derives the run's dock content — a progress block and, at each pending
 * gate, the interactive block that collects its input — from the run's
 * log-derived state plus its decoded step outputs. The `ui.tsx` panel stays as
 * the run-page strangler fallback.
 *
 * Gate → block:
 *   intake  → form   (single required `organizationDomain` text field; payload
 *             `{ organizationDomain }`). The panel additionally offers a
 *             pushToAttio checkbox; the dock form omits it (the flag is optional
 *             per SumbleIntakePayloadSchema and defaults to not pushing).
 *   review  → choice (Approve / Reject; each option carries the verbatim
 *             `{ approved }` resume payload). When the brief is decodable it is
 *             shown as a markdown preview above the choice.
 *
 * Every emitted payload is validated at the /resume boundary by the matching
 * schema in @workbench/shared (SumbleIntakePayloadSchema / SumbleReviewPayloadSchema).
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
import { parseAccountBrief } from "./parse";

export const INTAKE_SIGNAL = "intake";
export const REVIEW_SIGNAL = "review";

export interface SumbleAccountIntelBlockInput extends DockRunInput {
  /** Decoded step outputs keyed by stepId, as `stepOutputsFromLog` produces. */
  stepOutputs: Record<string, unknown>;
}

function runPageLink(
  runId: string,
  title: string,
  description: string,
): UIBlock {
  return { kind: "link", url: `/workflows/${runId}`, title, description };
}

function intakeForm(signalName: string): UIBlock {
  const organizationDomain: FormField = {
    kind: "text",
    name: "organizationDomain",
    label: "Company domain or Sumble company ID",
    placeholder: "acme.com",
    required: true,
  };
  return {
    kind: "form",
    prompt:
      "Enter the account to research. We pull the org shape, tech stack, contacts, and buying signals, then write a reviewable brief.",
    signalName,
    submitLabel: "Research account",
    fields: [organizationDomain],
  };
}

function reviewChoice(signalName: string): UIBlock {
  return {
    kind: "choice",
    prompt: "Approve the account brief to save it, or reject to discard it.",
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

export function buildSumbleAccountIntelBlocks(
  input: SumbleAccountIntelBlockInput,
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
  input: SumbleAccountIntelBlockInput,
): UIBlock[] {
  if (signalName === INTAKE_SIGNAL) {
    return [intakeForm(signalName)];
  }

  if (signalName === REVIEW_SIGNAL) {
    const brief = parseAccountBrief(input.stepOutputs.synthesize);
    if (brief.status === "ok") {
      return [
        {
          kind: "markdown",
          title: brief.value.title,
          source: brief.value.content,
          collapsible: true,
        },
        reviewChoice(signalName),
      ];
    }
    return [reviewChoice(signalName)];
  }

  // Any unknown gate needs input the dock can't collect — send the user to the
  // run page rather than POST an empty payload and corrupt the run.
  return [
    runPageLink(
      input.runId,
      "Continue on the run page",
      "This run needs input the dock can't collect yet — continue on the run page.",
    ),
  ];
}
