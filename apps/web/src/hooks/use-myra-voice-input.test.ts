import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { PREFERENCE_KEYS } from "@workbench/ui";

const capabilityEnabled = mock(() => true);
mock.module("./use-me-features", () => ({
  useMeFeatures: () => ({
    data: { features: [{ name: "voice-input", enabled: capabilityEnabled() }] },
  }),
  isFeatureEnabled: (
    data: { features: { name: string; enabled: boolean }[] } | undefined,
    name: string,
  ) => data?.features.some((f) => f.name === name && f.enabled) ?? false,
}));

import { useMyraVoiceInput } from "./use-myra-voice-input";

const STORAGE_KEY = PREFERENCE_KEYS.myraVoiceInput;

afterEach(() => {
  localStorage.clear();
  capabilityEnabled.mockReset();
  capabilityEnabled.mockReturnValue(true);
});

describe("useMyraVoiceInput", () => {
  it("defaults on when the owner capability is enabled and writes nothing on mount", () => {
    const { result } = renderHook(() => useMyraVoiceInput());

    expect(result.current.capabilityEnabled).toBe(true);
    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reflects a persisted opt-out and can opt back in", () => {
    localStorage.setItem(STORAGE_KEY, "false");
    const { result } = renderHook(() => useMyraVoiceInput());

    expect(result.current.enabled).toBe(false);

    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("true");
  });

  it("reports voice off when the owner has not enabled the capability", () => {
    capabilityEnabled.mockReturnValue(false);
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useMyraVoiceInput());

    expect(result.current.capabilityEnabled).toBe(false);
    expect(result.current.enabled).toBe(false);
  });
});
