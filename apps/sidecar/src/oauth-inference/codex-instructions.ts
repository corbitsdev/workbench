import { GPT_5_CODEX_PROMPT } from "./gpt-5-codex-prompt";

// The Codex backend pins the Responses `instructions` field to the official
// prompt and 400s on anything else. Workbench ships the bundled copy; refresh
// from upstream openai/codex when the backend starts rejecting it.

const PROMPT_SENTINEL = "You are Codex";
const MIN_PROMPT_LENGTH = 1000;

export function isValidCodexPrompt(text: string): boolean {
  return text.length >= MIN_PROMPT_LENGTH && text.startsWith(PROMPT_SENTINEL);
}

export function codexInstructions(): string {
  return GPT_5_CODEX_PROMPT;
}
