import { describe, expect, it } from "bun:test";
import {
  isMyraVoiceInputBuildEnabled,
  isMyraVoiceInputEnabled,
} from "./myra-voice-input";

const buildOn = { VITE_MYRA_VOICE_INPUT: "true" } as const;
const buildOff = { VITE_MYRA_VOICE_INPUT: "false" } as const;

describe("isMyraVoiceInputBuildEnabled", () => {
  it("is true only when the build flag is true", () => {
    expect(isMyraVoiceInputBuildEnabled(buildOn)).toBe(true);
    expect(isMyraVoiceInputBuildEnabled(buildOff)).toBe(false);
    expect(isMyraVoiceInputBuildEnabled({})).toBe(false);
  });
});

describe("isMyraVoiceInputEnabled", () => {
  it("is false when the build does not support voice", () => {
    expect(isMyraVoiceInputEnabled(null, buildOff)).toBe(false);
    expect(isMyraVoiceInputEnabled("true", buildOff)).toBe(false);
  });

  it("defaults on when the build supports voice and the user has not opted out", () => {
    expect(isMyraVoiceInputEnabled(null, buildOn)).toBe(true);
    expect(isMyraVoiceInputEnabled("true", buildOn)).toBe(true);
  });

  it("respects an explicit user opt-out", () => {
    expect(isMyraVoiceInputEnabled("false", buildOn)).toBe(false);
  });
});