import { describe, expect, test } from "bun:test";
import {
  catalogManagedNames,
  filterCatalogByAvailableTools,
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

  test("matches a tool on its keywords corpus when name and description do not", () => {
    const withKeywords: ToolCatalog = [
      {
        package: "attio",
        summary: "Attio CRM records and tasks.",
        tags: ["crm"],
        tools: [
          {
            name: "attio__query_records",
            description: "Query CRM records.",
            keywords:
              "Filter companies and people by revenue or headcount ranges.",
          },
        ],
      },
    ];
    const results = searchCatalog(withKeywords, { query: "headcount" });
    expect(results.map((r) => r.package)).toContain("attio");
  });

  test("keeps the friendly description as display text and never surfaces keywords", () => {
    const withKeywords: ToolCatalog = [
      {
        package: "attio",
        summary: "Attio CRM records and tasks.",
        tags: ["crm"],
        tools: [
          {
            name: "attio__query_records",
            description: "Query CRM records.",
            keywords: "headcount revenue firmographics",
          },
        ],
      },
    ];
    const match = searchCatalog(withKeywords, { query: "firmographics" })[0]
      ?.tools[0];
    expect(match?.description).toBe("Query CRM records.");
    expect((match as Record<string, unknown>).keywords).toBeUndefined();
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

describe("filterCatalogByAvailableTools", () => {
  test("drops a package whose tools did not load (missing credential)", () => {
    const available = new Set(["attio__query_records", "attio__create_note"]);
    const filtered = filterCatalogByAvailableTools(catalog, available);
    expect(filtered.map((e) => e.package)).toEqual(["attio"]);
  });

  test("keeps a package whose tools all loaded", () => {
    const available = new Set([
      "attio__query_records",
      "attio__create_note",
      "linear__list_issues",
    ]);
    const filtered = filterCatalogByAvailableTools(catalog, available);
    expect(filtered.map((e) => e.package).sort()).toEqual(["attio", "linear"]);
  });

  test("keeps only the tools that loaded within a partially-available package", () => {
    const available = new Set(["attio__query_records"]);
    const filtered = filterCatalogByAvailableTools(catalog, available);
    const attio = filtered.find((e) => e.package === "attio");
    expect(attio?.tools.map((t) => t.name)).toEqual(["attio__query_records"]);
  });

  test("returns an empty catalog when nothing loaded", () => {
    expect(filterCatalogByAvailableTools(catalog, new Set())).toEqual([]);
  });

  test("does not mutate the source catalog", () => {
    const before = JSON.stringify(catalog);
    filterCatalogByAvailableTools(catalog, new Set(["attio__query_records"]));
    expect(JSON.stringify(catalog)).toBe(before);
  });
});
