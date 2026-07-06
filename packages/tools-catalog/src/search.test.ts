import { describe, expect, test } from "bun:test";
import {
  catalogManagedNames,
  resolveLoadRequest,
  searchCatalog,
} from "./search";
import type { ToolCatalog } from "./schema";

const catalog: ToolCatalog = [
  {
    package: "attio",
    summary: "Attio CRM records and tasks.",
    tags: ["crm", "companies"],
    tools: [
      { name: "attio__query_records", description: "Query CRM records." },
      { name: "attio__create_note", description: "Create a note on a record." },
    ],
  },
  {
    package: "linear",
    summary: "Linear issues and teams.",
    tags: ["issues", "engineering"],
    tools: [
      { name: "linear__list_issues", description: "List Linear issues." },
    ],
  },
];

describe("catalogManagedNames", () => {
  test("collects every tool name across packages", () => {
    expect(catalogManagedNames(catalog)).toEqual(
      new Set([
        "attio__query_records",
        "attio__create_note",
        "linear__list_issues",
      ]),
    );
  });
});

describe("searchCatalog", () => {
  test("scores tool-name matches above unrelated packages and ranks them first", () => {
    const results = searchCatalog(catalog, { query: "issues" });
    expect(results[0]?.package).toBe("linear");
  });

  test("matches on tags", () => {
    const results = searchCatalog(catalog, { query: "crm" });
    expect(results.map((r) => r.package)).toContain("attio");
  });

  test("returns no packages when nothing matches a real term", () => {
    expect(searchCatalog(catalog, { query: "nonexistentzzz" })).toEqual([]);
  });

  test("empty query browses every package", () => {
    const results = searchCatalog(catalog, { query: "   " });
    expect(results).toHaveLength(2);
    expect(results[0]?.tools.length).toBeGreaterThan(0);
  });

  test("package filter restricts results", () => {
    const results = searchCatalog(catalog, { query: "", package: "attio" });
    expect(results.map((r) => r.package)).toEqual(["attio"]);
  });

  test("tags filter excludes non-tagged entries", () => {
    const results = searchCatalog(catalog, {
      query: "",
      tags: ["engineering"],
    });
    expect(results.map((r) => r.package)).toEqual(["linear"]);
  });
});

describe("resolveLoadRequest", () => {
  test("resolves explicit names and reports unknown ones", () => {
    const result = resolveLoadRequest(catalog, {
      names: ["attio__query_records", "made_up_tool"],
    });
    expect(result.resolved).toEqual(["attio__query_records"]);
    expect(result.unknownNames).toEqual(["made_up_tool"]);
    expect(result.unknownPackage).toBeNull();
  });

  test("resolves a whole package to all its tools", () => {
    const result = resolveLoadRequest(catalog, { package: "attio" });
    expect(new Set(result.resolved)).toEqual(
      new Set(["attio__query_records", "attio__create_note"]),
    );
  });

  test("names and package combine without duplicates", () => {
    const result = resolveLoadRequest(catalog, {
      names: ["attio__query_records"],
      package: "attio",
    });
    expect(new Set(result.resolved)).toEqual(
      new Set(["attio__query_records", "attio__create_note"]),
    );
  });

  test("reports an unknown package", () => {
    const result = resolveLoadRequest(catalog, { package: "salesforce" });
    expect(result.resolved).toEqual([]);
    expect(result.unknownPackage).toBe("salesforce");
  });
});
