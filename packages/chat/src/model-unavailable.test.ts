import { describe, expect, test } from "bun:test";
import { InferenceResolutionError } from "@corbits/folded-runs";

import {
  consumerTurnError,
  isModelUnavailableCause,
  MODEL_UNAVAILABLE_CONSUMER_MESSAGE,
  ModelUnavailableError,
  wrapWakeInferenceError,
} from "./model-unavailable";

describe("wrapWakeInferenceError", () => {
  test("wraps InferenceResolutionError as ModelUnavailableError with consumer copy", () => {
    const cause = new InferenceResolutionError(
      "the woken instance",
      'No launchable inference source for model "claude-sonnet-5"',
    );
    const wrapped = wrapWakeInferenceError(cause);
    expect(wrapped).toBeInstanceOf(ModelUnavailableError);
    expect((wrapped as Error).message).toBe(MODEL_UNAVAILABLE_CONSUMER_MESSAGE);
    expect((wrapped as Error).message).not.toContain("claude-sonnet-5");
    expect((wrapped as Error).message).not.toMatch(/HTTP/);
    expect((wrapped as Error).cause).toBe(cause);
  });

  test("leaves unrelated errors alone", () => {
    const err = new Error("the agent is unreachable");
    expect(wrapWakeInferenceError(err)).toBe(err);
  });
});

describe("consumerTurnError", () => {
  test("never writes the raw resolution dump onto a turn", () => {
    const cause = new InferenceResolutionError(
      "the woken instance",
      'No launchable inference source for model "claude-sonnet-5"',
    );
    expect(consumerTurnError(cause)).toBe(MODEL_UNAVAILABLE_CONSUMER_MESSAGE);
    expect(consumerTurnError(new ModelUnavailableError(cause))).toBe(
      MODEL_UNAVAILABLE_CONSUMER_MESSAGE,
    );
    expect(consumerTurnError(new Error("sidecar unavailable"))).toBe(
      "sidecar unavailable",
    );
  });
});

describe("isModelUnavailableCause", () => {
  test("recognizes the wrapped and unwrapped resolution failures", () => {
    const cause = new InferenceResolutionError("launch", "no catalog source");
    expect(isModelUnavailableCause(cause)).toBe(true);
    expect(isModelUnavailableCause(new ModelUnavailableError(cause))).toBe(
      true,
    );
    expect(isModelUnavailableCause(new Error("sidecar unavailable"))).toBe(
      false,
    );
  });
});
