import { describe, expect, it } from "bun:test";
import { buildDispatchAllowedToolNames } from "./tool-dispatch-allowed-names";

describe("buildDispatchAllowedToolNames", () => {
  it("does not admit loaded catalog tools absent from hub grants", () => {
    const granted = ["search_tools", "load_tools"];
    const loaded = new Set([
      "search_tools",
      "load_tools",
      "attio__query_records",
      "linear__list_issues",
    ]);
    const allowed = buildDispatchAllowedToolNames(granted, loaded, [
      "search_tools",
      "load_tools",
    ]);
    expect(allowed.has("attio__query_records")).toBe(false);
    expect(allowed.has("linear__list_issues")).toBe(false);
    expect(allowed.has("search_tools")).toBe(true);
  });

  it("includes granted loaded native tools", () => {
    const granted = ["search_tools", "attio__query_records"];
    const loaded = new Set(["attio__query_records"]);
    const allowed = buildDispatchAllowedToolNames(granted, loaded, []);
    expect(allowed.has("attio__query_records")).toBe(true);
  });
});