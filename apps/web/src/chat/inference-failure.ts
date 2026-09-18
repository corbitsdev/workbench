// Reply-prose match against classified failures (see
// docs/chat-wire-contract.md for why this can't be a structured read).
export const CLASSIFIED_INFERENCE_FAILURE_PREAMBLES: readonly string[] = [
  "This agent could not complete your request due to a credential error",
  "This agent could not complete your request because the API quota has been exhausted",
];

export {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
} from "./wire/consumer-inference-text";

export function isClassifiedInferenceFailureText(text: string): boolean {
  return CLASSIFIED_INFERENCE_FAILURE_PREAMBLES.some((preamble) => text.startsWith(preamble));
}
