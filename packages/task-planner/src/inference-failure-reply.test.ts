import { describe, expect, test } from "bun:test";

import { isInferenceFailureReply } from "./inference-failure-reply";

describe("isInferenceFailureReply", () => {
  test("matches every inference-failure preamble", () => {
    expect(
      isInferenceFailureReply(
        "This agent could not complete your request due to an unrecoverable inference error [HTTP 500]: upstream saturated",
      ),
    ).toBe(true);
    expect(
      isInferenceFailureReply(
        "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
      ),
    ).toBe(true);
    expect(
      isInferenceFailureReply(
        "This agent could not complete your request because the API quota has been exhausted [HTTP 402]: quota exceeded",
      ),
    ).toBe(true);
    expect(
      isInferenceFailureReply(
        "This agent encountered a temporary error communicating with the inference provider [HTTP 503]: timed out",
      ),
    ).toBe(true);
    expect(
      isInferenceFailureReply("This agent's inference request was aborted"),
    ).toBe(true);
  });

  test("does not match a genuine plan reply, malformed or not", () => {
    expect(
      isInferenceFailureReply(
        '{"kind": "task", "use": "wfd_summarizer", "refinedOutcome": "x"}',
      ),
    ).toBe(false);
    expect(isInferenceFailureReply("not json at all")).toBe(false);
  });
});
