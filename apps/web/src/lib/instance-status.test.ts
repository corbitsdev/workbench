/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import { humanizeInstanceStatus } from "./instance-status";

describe("humanizeInstanceStatus", () => {
  it("maps the known wire statuses to plain labels", () => {
    expect(humanizeInstanceStatus("running")).toBe("Active");
    expect(humanizeInstanceStatus("stopped")).toBe("Asleep");
    expect(humanizeInstanceStatus("ended")).toBe("Asleep");
    expect(humanizeInstanceStatus("provisioning")).toBe("Starting");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(humanizeInstanceStatus(" Running ")).toBe("Active");
    expect(humanizeInstanceStatus("STOPPED")).toBe("Asleep");
  });

  it("returns undefined for error-ish and unknown statuses so callers omit the row", () => {
    expect(humanizeInstanceStatus("error")).toBeUndefined();
    expect(humanizeInstanceStatus("failed")).toBeUndefined();
    expect(humanizeInstanceStatus("crash-looping")).toBeUndefined();
    expect(humanizeInstanceStatus("")).toBeUndefined();
  });
});
