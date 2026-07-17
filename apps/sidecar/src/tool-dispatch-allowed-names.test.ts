import { describe, expect, it } from "bun:test";
import { buildDispatchAllowedToolNames } from "./tool-dispatch-allowed-names";

describe("buildDispatchAllowedToolNames", () => {
  it("does not admit loaded catalog tools absent from every grant set", () => {
    const granted = ["search_tools", "load_tools"];
    const loaded = new Set([
      "search_tools",
      "load_tools",
      "attio__query_records",
      "linear__list_issues",
    ]);
    const allowed = buildDispatchAllowedToolNames(
      granted,
      loaded,
      ["search_tools", "load_tools"],
      new Set<string>(),
    );
    expect(allowed.has("attio__query_records")).toBe(false);
    expect(allowed.has("linear__list_issues")).toBe(false);
    expect(allowed.has("search_tools")).toBe(true);
  });

  it("includes granted loaded native tools", () => {
    const granted = ["search_tools", "attio__query_records"];
    const loaded = new Set(["attio__query_records"]);
    const allowed = buildDispatchAllowedToolNames(
      granted,
      loaded,
      [],
      new Set<string>(),
    );
    expect(allowed.has("attio__query_records")).toBe(true);
  });

  it("admits loaded package tools granted via the catalog grant set", () => {
    const granted = ["mail_send"];
    const loaded = new Set(["sumble__search_technologies", "linear__list_issues"]);
    const allowed = buildDispatchAllowedToolNames(
      granted,
      loaded,
      ["search_tools", "load_tools"],
      new Set(["sumble__search_technologies"]),
    );
    expect(allowed.has("sumble__search_technologies")).toBe(true);
    expect(allowed.has("linear__list_issues")).toBe(false);
    expect(allowed.has("mail_send")).toBe(true);
    expect(allowed.has("load_tools")).toBe(true);
  });

  it("admits every loaded tool when the agent has no dynamic catalog", () => {
    const granted = ["mail_send"];
    const loaded = new Set(["granola__list_calls", "exa__search"]);
    const allowed = buildDispatchAllowedToolNames(granted, loaded, [], undefined);
    expect(allowed.has("granola__list_calls")).toBe(true);
    expect(allowed.has("exa__search")).toBe(true);
    expect(allowed.has("mail_send")).toBe(true);
  });
});
