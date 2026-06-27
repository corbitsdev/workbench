import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useArchivedWorkflowRuns } from "./use-archived-workflow-runs";

const STORAGE_KEY = "cw-archived-workflow-runs";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useArchivedWorkflowRuns", () => {
  it("starts empty and writes nothing on mount", () => {
    const { result } = renderHook(() => useArchivedWorkflowRuns());
    expect(result.current.archived.size).toBe(0);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("reads a persisted list on init", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["run-1"]));
    const { result } = renderHook(() => useArchivedWorkflowRuns());
    expect(result.current.isArchived("run-1")).toBe(true);
    expect(result.current.isArchived("run-2")).toBe(false);
  });

  it("archives and unarchives a run, persisting the list", () => {
    const { result } = renderHook(() => useArchivedWorkflowRuns());
    act(() => result.current.setArchived("run-1", true));
    expect(result.current.isArchived("run-1")).toBe(true);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      "run-1",
    ]);
    act(() => result.current.setArchived("run-1", false));
    expect(result.current.isArchived("run-1")).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([]);
  });

  it("degrades a malformed stored blob to empty", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    const { result } = renderHook(() => useArchivedWorkflowRuns());
    expect(result.current.archived.size).toBe(0);
  });
});
