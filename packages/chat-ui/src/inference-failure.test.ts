import { describe, expect, test } from "bun:test";

import { isClassifiedInferenceFailureText } from "./inference-failure";

describe("isClassifiedInferenceFailureText", () => {
  test("matches a credential_failure reply, status code included", () => {
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request due to a credential error [HTTP 401]: invalid api key",
      ),
    ).toBe(true);
  });

  test("matches a quota_exhausted reply", () => {
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request because the API quota has been exhausted [HTTP 429]: rate limited",
      ),
    ).toBe(true);
  });

  test("does not match a retryable/context_overflow/fatal/aborted reply", () => {
    expect(
      isClassifiedInferenceFailureText(
        "This agent encountered a temporary error communicating with the inference provider [HTTP 503]: upstream down",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request because the conversation exceeded the model's context limit: too long",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText(
        "This agent could not complete your request due to an unrecoverable inference error [HTTP 402]: payment required",
      ),
    ).toBe(false);
    expect(
      isClassifiedInferenceFailureText(
        "This agent's inference request was aborted",
      ),
    ).toBe(false);
  });

  test("does not match an ordinary agent reply, even one that mentions credentials mid-sentence", () => {
    expect(
      isClassifiedInferenceFailureText(
        "I'd due to a credential error need your API key to continue.",
      ),
    ).toBe(false);
    expect(isClassifiedInferenceFailureText("Here are the results you asked for.")).toBe(
      false,
    );
  });
});
