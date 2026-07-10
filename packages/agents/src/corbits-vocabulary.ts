import type { PromptSection } from "./prompt-builder";

const CORBITS_VOCABULARY_CONTENT =
  "Treat Corbits, Corbits.dev, Interchange, and Faremeter as canonical Corbits names; spell them exactly. When source material contains a clear speech-to-text or spelling variant, use the canonical spelling in your output. Do not replace an ambiguous term unless surrounding context identifies it.";

export const CORBITS_VOCABULARY_SECTION: PromptSection = {
  tag: "terminology",
  content: CORBITS_VOCABULARY_CONTENT,
};

export function withCorbitsVocabulary(systemPrompt: string): string {
  return [CORBITS_VOCABULARY_CONTENT, systemPrompt].join("\n\n");
}
