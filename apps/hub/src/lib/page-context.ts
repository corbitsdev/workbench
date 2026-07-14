import { buildSystemPrompt, type PromptFormat } from "@workbench/prompts";
import { promptFormatForProvider } from "./operator-profile";

/** Upper bound for client-supplied page context (chars). */
export const MAX_PAGE_CONTEXT_LENGTH = 8_000;

export function normalizePageContextInput(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_PAGE_CONTEXT_LENGTH) {
    return trimmed.slice(0, MAX_PAGE_CONTEXT_LENGTH);
  }
  return trimmed;
}

export function appendPageContextToPrompt(
  basePrompt: string,
  pageContext: string,
  provider: string,
): string {
  const format: PromptFormat = promptFormatForProvider(provider);
  const block = buildSystemPrompt(
    [
      {
        tag: "page_context",
        content: pageContext,
      },
    ],
    format,
  );
  return `${basePrompt}\n\n${block}`;
}