import { describe, expect, test } from "bun:test";

import {
  CONSUMER_INFERENCE_FAILURE_NOTICE,
  consumerFacingInferenceText,
} from "./consumer-inference-text";

describe("consumerFacingInferenceText", () => {
  test("leaves ordinary replies unchanged", () => {
    expect(consumerFacingInferenceText("Hello there.")).toBe("Hello there.");
  });

  test("keeps a classified preamble and drops a trailing HTTP dump", () => {
    expect(
      consumerFacingInferenceText(
        "This agent could not complete your request due to a credential error [HTTP 401]: API key is invalid.",
      ),
    ).toBe(
      "This agent could not complete your request due to a credential error",
    );
  });

  test("a forced HTTP dump is not consumer copy", () => {
    const text = consumerFacingInferenceText("[HTTP 401]: API key is invalid.");
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text).not.toMatch(/\[HTTP/i);
    expect(text).not.toMatch(/401/);
    expect(text.toLowerCase()).not.toContain("api key is invalid");
  });

  test("a JSON provider-error object is not consumer copy", () => {
    const text = consumerFacingInferenceText(
      '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
    );
    expect(text).toBe(CONSUMER_INFERENCE_FAILURE_NOTICE);
    expect(text.toLowerCase()).not.toContain("invalid_api_key");
  });
});
