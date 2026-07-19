import { describe, expect, test } from "bun:test";
import {
  resolveInferenceOptionsFromDials,
  readInferenceParamsForDirector,
  INFERENCE_PARAMS_ENV_KEY,
} from "./inference-params";
import { buildInferenceParamsMarker } from "./inference-params-marker";

describe("resolveInferenceOptionsFromDials", () => {
  test("deepseek flash maps creative dial to reasoning_effort only", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "deepseek-v4-flash",
      creative: 0,
      thinking: null,
    });
    expect(opts.temperature).toBeUndefined();
    expect(opts.providerOptions).toEqual({ reasoning_effort: "medium" });
  });

  test("kimi thinking on omits temperature", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "kimi-k2.6",
      creative: 80,
      thinking: 80,
    });
    expect(opts.temperature).toBeUndefined();
    expect(opts.providerOptions).toEqual({ thinking: { type: "enabled" } });
  });

  test("kimi thinking off sends temperature", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "kimi-k2.6",
      creative: 50,
      thinking: 10,
    });
    expect(opts.temperature).toBeCloseTo(0.6, 5);
    expect(opts.providerOptions).toEqual({ thinking: { type: "disabled" } });
  });

  test("opus thinking on uses effort and no temperature", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "claude-opus-4-8",
      creative: 50,
      thinking: 90,
    });
    expect(opts.temperature).toBeUndefined();
    expect(opts.thinking).toEqual({ enabled: true });
    expect(opts.providerOptions).toEqual({ anthropicThinkingEffort: "high" });
  });

  test("opus thinking off sends temperature only", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "claude-opus-4-8",
      creative: 0,
      thinking: 0,
    });
    expect(opts.thinking).toBeUndefined();
    expect(opts.temperature).toBeCloseTo(0.2, 5);
  });

  test("kimi-k3 default (null) dial keeps thinking disabled, mirroring kimi-k2.6", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "kimi-k3",
      creative: null,
      thinking: null,
    });
    expect(opts.providerOptions).toEqual({ thinking: { type: "disabled" } });
  });

  test("kimi-k3 thinking on omits temperature", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "kimi-k3",
      creative: 80,
      thinking: 80,
    });
    expect(opts.temperature).toBeUndefined();
    expect(opts.providerOptions).toEqual({ thinking: { type: "enabled" } });
  });

  test("kimi-k3 thinking off sends temperature", () => {
    const opts = resolveInferenceOptionsFromDials({
      model: "kimi-k3",
      creative: 50,
      thinking: 10,
    });
    expect(opts.temperature).toBeCloseTo(0.6, 5);
    expect(opts.providerOptions).toEqual({ thinking: { type: "disabled" } });
  });
});

describe("readInferenceParamsForDirector", () => {
  test("prefers env over marker", () => {
    const marker = buildInferenceParamsMarker({
      model: "kimi-k2.6",
      creative: 1,
      thinking: 1,
    });
    const env = {
      [INFERENCE_PARAMS_ENV_KEY]: {
        model: "deepseek-v4-flash",
        creative: 99,
        thinking: null,
      },
    };
    const dials = readInferenceParamsForDirector(env, `prompt\n\n${marker}`);
    expect(dials?.model).toBe("deepseek-v4-flash");
    expect(dials?.creative).toBe(99);
  });

  test("falls back to marker", () => {
    const marker = buildInferenceParamsMarker({
      model: "kimi-k2.6",
      creative: 42,
      thinking: null,
    });
    const dials = readInferenceParamsForDirector({}, `x\n\n${marker}`);
    expect(dials).toEqual({
      model: "kimi-k2.6",
      creative: 42,
      thinking: null,
    });
  });
});
