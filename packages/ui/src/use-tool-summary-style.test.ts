import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useToolSummaryStyle } from "./use-tool-summary-style";

const STORAGE_KEY = "cw-tool-summary-style";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useToolSummaryStyle", () => {
  it("defaults to symbols", () => {
    const { result } = renderHook(() => useToolSummaryStyle());
    expect(result.current.style).toBe("symbols");
  });

  it("reads a valid persisted style on init", () => {
    localStorage.setItem(STORAGE_KEY, "mixed");
    const { result } = renderHook(() => useToolSummaryStyle());
    expect(result.current.style).toBe("mixed");
  });

  it("ignores an unknown persisted value and falls back to symbols", () => {
    localStorage.setItem(STORAGE_KEY, "fancy");
    const { result } = renderHook(() => useToolSummaryStyle());
    expect(result.current.style).toBe("symbols");
  });

  it("persists when the style changes", () => {
    const { result } = renderHook(() => useToolSummaryStyle());
    act(() => result.current.setStyle("varied"));
    expect(result.current.style).toBe("varied");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("varied");
  });
});
