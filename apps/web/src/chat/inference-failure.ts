// Reply-prose match against classified failures.
export const CLASSIFIED_INFERENCE_FAILURE_PREAMBLES: readonly string[] = [
  "This agent could not complete your request due to a credential error",
  "This agent could not complete your request because the API quota has been exhausted",
];

export function isClassifiedInferenceFailureText(text: string): boolean {
  return CLASSIFIED_INFERENCE_FAILURE_PREAMBLES.some((preamble) => text.startsWith(preamble));
}
