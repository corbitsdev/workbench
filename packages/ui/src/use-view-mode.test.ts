import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useViewMode } from "./use-view-mode";
import {
  hydrateServerPreferences,
  setPreferencePersister,
} from "./preferences-store";

beforeEach(() => {
  localStorage.clear();
  setPreferencePersister(null);
});

afterEach(() => {
  localStorage.clear();
  setPreferencePersister(null);
});

describe("useViewMode", () => {
  it("defaults to grid when nothing is stored", () => {
    const { result } = renderHook(() => useViewMode("artifacts"));
    expect(result.current.mode).toBe("grid");
  });

  it("switches the layout and persists the change server-side", () => {
    const persist = mock((_k: string, _v: string) => {});
    setPreferencePersister(persist);
    const { result } = renderHook(() => useViewMode("tools"));

    act(() => result.current.setMode("rows"));

    expect(result.current.mode).toBe("rows");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]).toEqual(["cw-view-tools", "rows"]);
  });

  it("scopes are independent", () => {
    const tools = renderHook(() => useViewMode("tools"));
    const skills = renderHook(() => useViewMode("skills"));
    act(() => tools.result.current.setMode("rows"));
    expect(tools.result.current.mode).toBe("rows");
    expect(skills.result.current.mode).toBe("grid");
  });

  it("reflects a value hydrated from the server bootstrap", () => {
    const { result } = renderHook(() => useViewMode("artifacts"));
    expect(result.current.mode).toBe("grid");
    act(() => hydrateServerPreferences({ artifactsViewMode: "rows" }));
    expect(result.current.mode).toBe("rows");
  });
});
