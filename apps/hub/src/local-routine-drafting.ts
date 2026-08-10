// Honest local stand-in for describe-to-agent drafting until Myra (or
// another bench agent) owns the RoutineDraftingPort. Splits the free-text
// prompt into step titles and optionally lifts a name from the first line —
// never calls Interchange or an LLM.

import type { RoutineDraftingPort } from "@corbits/routines";

export type DraftedStepProposal = {
  readonly title: string;
  readonly detail?: string;
};

/**
 * Turn a free-text prompt into non-empty step titles.
 * Prefer bullet/numbered lines; otherwise split on sentence boundaries.
 * Always returns at least one step (the whole prompt trimmed, or a fallback).
 */
export function proposedStepsFromPrompt(
  prompt: string,
): readonly DraftedStepProposal[] {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    return [{ title: "Follow the described routine" }];
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const bulletTitles = lines
    .map((line) => line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((title) => title.length > 0);

  // Multi-line prompts that look like a checklist: use each line as a step.
  if (lines.length > 1 && bulletTitles.length === lines.length) {
    return bulletTitles.map((title) => ({ title: title.slice(0, 200) }));
  }

  // Single block: split into sentences.
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((part) =>
      part
        .trim()
        .replace(/^[.!?]+|[.!?]+$/g, "")
        .trim(),
    )
    .filter((part) => part.length > 0);

  if (sentences.length > 1) {
    return sentences.map((title) => ({ title: title.slice(0, 200) }));
  }

  return [{ title: trimmed.slice(0, 200) }];
}

/** First non-empty line, capped, as a suggested routine name. */
export function proposedNameFromPrompt(prompt: string): string | undefined {
  const first = prompt
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ""))
    .find((line) => line.length > 0);
  if (first === undefined) return undefined;
  // Prefer a short title-like first line; drop trailing punctuation.
  const name = first
    .replace(/[.!?]+$/, "")
    .slice(0, 80)
    .trim();
  return name === "" ? undefined : name;
}

export type LocalRoutineDraftingOptions = {
  /**
   * Optional host hook: pick a workflow definition for the draft when the
   * prompt alone cannot name one. Return null when the tenant has none so
   * the draft keeps definitionId null honestly.
   */
  readonly resolveDefinitionId?: (tenantId: string) => Promise<string | null>;
};

export function createLocalRoutineDrafting(
  options: LocalRoutineDraftingOptions = {},
): RoutineDraftingPort {
  return {
    async propose({ prompt, tenantId }) {
      const steps = proposedStepsFromPrompt(prompt);
      const name = proposedNameFromPrompt(prompt);
      const definitionId =
        options.resolveDefinitionId !== undefined
          ? await options.resolveDefinitionId(tenantId)
          : null;
      return {
        steps,
        ...(name !== undefined ? { name } : {}),
        ...(definitionId !== null ? { definitionId } : {}),
      };
    },
  };
}
