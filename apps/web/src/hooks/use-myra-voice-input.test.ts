import { afterEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { PREFERENCE_KEYS } from "@workbench/ui";

const buildEnabled = mock(() => true);
mock.module("../lib/myra-voice-input", () => ({
  isMyraVoiceInputBuildEnabled: () => buildEnabled(),
  isMyraVoiceInputEnabled: (raw: string | null) => {
    if (!buildEnabled()) return false;
    return raw !== "false";
  },
}));

import { useMyraVoiceInput } from "./use-myra-voice-input";

const STORAGE_KEY = PREFERENCE_KEYS.myraVoiceInput;

afterEach(() => {
  localStorage.clear();
  buildEnabled.mockReset();
  buildEnabled.mockReturnValue(true);
});

describe("useMyraVoiceInput", () => {
  it("defaults on when the build supports voice and writes nothing on mount", () => {
    const { result } = renderHook(() => useMyraVoiceInput());

    expect(result.current.buildEnabled).toBe(true);
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

  it("reports voice off when the build does not support it", () => {
    buildEnabled.mockReturnValue(false);
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useMyraVoiceInput());

    expect(result.current.buildEnabled).toBe(false);
    expect(result.current.enabled).toBe(false);
  });
});