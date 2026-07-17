import { formatDataSection, type PromptFormat } from "@workbench/prompts";
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

/**
 * Client-supplied "what page is the user on" text — retrieved data, not
 * static prompt copy — so it is rendered via formatDataSection: escaped for
 * the target provider format, and thus unable to close its own section or
 * inject a heading/fence into the surrounding prompt.
 */
export function appendPageContextToPrompt(
  basePrompt: string,
  pageContext: string,
  provider: string,
): string {
  const format: PromptFormat = promptFormatForProvider(provider);
  const block = formatDataSection(
    { tag: "page_context", content: pageContext },
    format,
  );
  return `${basePrompt}\n\n${block}`;
}
