// Recognizes a one-shot Myra reply that is actually an inference-failure
// report (saturation, a 402, a timeout, ...), not a malformed plan —
// mirrors every preamble in `@intx/inference/src/default-director.ts`'s
// `ERROR_PREAMBLE` (not exported upstream, so copied rather than
// imported). Broader on purpose than
// `@workbench/connections/provider-health`'s `isClassifiedInferenceFailure`
// / `packages/chat-ui/src/inference-failure.ts`'s
// `isClassifiedInferenceFailureText`, which only surface the two
// connection-fixable categories (`credential_failure`, `quota_exhausted`)
// to the shell as "go fix this" — here every category counts, since none
// of them ever contain a usable plan, and `runPlanner` only needs to
// know "was this actually an inference failure," not which kind.
const INFERENCE_FAILURE_PREAMBLES: readonly string[] = [
  "This agent could not complete your request due to a credential error",
  "This agent could not complete your request because the API quota has been exhausted",
  "This agent could not complete your request because the conversation exceeded the model's context limit",
  "This agent encountered a temporary error communicating with the inference provider",
  "This agent could not complete your request due to an unrecoverable inference error",
  "This agent's inference request was aborted",
];

export function isInferenceFailureReply(text: string): boolean {
  return INFERENCE_FAILURE_PREAMBLES.some((preamble) =>
    text.startsWith(preamble),
  );
}
