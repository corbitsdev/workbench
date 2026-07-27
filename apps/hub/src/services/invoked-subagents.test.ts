import { describe, expect, it } from "bun:test";
import { newInvokedSubagentId } from "./invoked-subagents";

describe("newInvokedSubagentId", () => {
  it("mints a prefixed workbench-local id", () => {
    const id = newInvokedSubagentId();
    expect(id).toMatch(/^mis_[0-9a-f]{32}$/);
  });

  it("does not mint through interchange's unregistered-kind path", () => {
    expect(newInvokedSubagentId().startsWith("undefined")).toBe(false);
  });

  it("mints a distinct id per call", () => {
    expect(newInvokedSubagentId()).not.toBe(newInvokedSubagentId());
  });
});
