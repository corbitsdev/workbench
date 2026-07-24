/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  STATUS_FILTER_OPTIONS,
  statusDotClass,
  statusLabel,
  statusTextClass,
} from "./workflow-run-status";

describe("STATUS_FILTER_OPTIONS", () => {
  it("includes Stopped as a filterable status", () => {
    expect(
      STATUS_FILTER_OPTIONS.some(
        (opt) => opt.value === "stopped" && opt.label === "Stopped",
      ),
    ).toBe(true);
  });
});

describe("statusLabel", () => {
  it("labels stopped as Stopped", () => {
    expect(statusLabel("stopped")).toBe("Stopped");
  });

  it("keeps the existing completed/failed labels", () => {
    expect(statusLabel("completed")).toBe("Completed");
    expect(statusLabel("failed")).toBe("Failed");
  });
});

describe("statusTextClass", () => {
  it("styles stopped as neutral text, not error red", () => {
    const cls = statusTextClass("stopped");
    expect(cls).toBe("text-text-3");
    expect(cls.includes("red")).toBe(false);
  });

  it("styles cancelled as the same neutral tone as stopped", () => {
    expect(statusTextClass("cancelled")).toBe("text-text-3");
  });

  it("keeps failed as red and completed as green", () => {
    expect(statusTextClass("failed")).toContain("red");
    expect(statusTextClass("completed")).toContain("green");
  });
});

describe("statusDotClass", () => {
  it("styles stopped as a neutral dot, not error red", () => {
    const cls = statusDotClass("stopped");
    expect(cls).toBe("bg-text-3");
    expect(cls.includes("red")).toBe(false);
  });

  it("styles cancelled as the same neutral tone as stopped", () => {
    expect(statusDotClass("cancelled")).toBe("bg-text-3");
  });

  it("keeps failed as red and completed as green", () => {
    expect(statusDotClass("failed")).toContain("red");
    expect(statusDotClass("completed")).toContain("green");
  });
});
