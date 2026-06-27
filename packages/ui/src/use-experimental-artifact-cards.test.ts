import { describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { PREFERENCE_KEYS } from "./preferences-store";
import { useExperimentalArtifactCards } from "./use-experimental-artifact-cards";

const STORAGE_KEY = PREFERENCE_KEYS.experimentalArtifactCards;

describe("useExperimentalArtifactCards", () => {
  it("defaults off and writes nothing on mount", () => {
    const { result } = renderHook(() => useExperimentalArtifactCards());

    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reads a persisted opt-in and can toggle it off", () => {
    localStorage.setItem(STORAGE_KEY, "true");
    const { result } = renderHook(() => useExperimentalArtifactCards());

    expect(result.current.enabled).toBe(true);

    act(() => result.current.setEnabled(false));
    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe("false");
  });
});
