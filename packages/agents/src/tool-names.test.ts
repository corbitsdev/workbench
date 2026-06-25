/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  canonicalizeToolNames,
  expandToolAliasGrants,
  providersForToolPackages,
  toLlmToolName,
  toolPackagesForCapabilities,
} from "./tool-names";

describe("toLlmToolName (CL-2306)", () => {
  it("maps a canonical name to <pkgShort>__<tool>, dropping a redundant prefix", () => {
    expect(toLlmToolName("@workbench/tools-exa/exa:exa_search")).toBe(
      "exa__search",
    );
    expect(
      toLlmToolName("@workbench/tools-firecrawl/firecrawl:firecrawl_scrape"),
    ).toBe("firecrawl__scrape");
    expect(
      toLlmToolName("@workbench/tools-attio/attio:attio_query_records"),
    ).toBe("attio__query_records");
  });

  it("keeps the tool name when it does not start with the package short prefix", () => {
    expect(toLlmToolName("@workbench/tools-exa/exa:web_search")).toBe(
      "exa__web_search",
    );
    expect(toLlmToolName("@workbench/tools-agents/agents:list_agents")).toBe(
      "agents__list_agents",
    );
  });

  it("passes bare local names through unchanged (already LLM-safe)", () => {
    expect(toLlmToolName("read_file")).toBe("read_file");
    expect(toLlmToolName("mail_send")).toBe("mail_send");
  });

  it("produces unique, charset-safe (<=64) names across the real tool registry", () => {
    const bare = [
      "list_agents",
      "list_principals",
      "attio_list_objects",
      "attio_query_records",
      "attio_search_records",
      "attio_get_record",
      "attio_list_workspace_members",
      "exa_search",
      "web_search",
      "firecrawl_scrape",
      "firecrawl_batch_scrape_status",
      "gamma_create_from_template",
      "github_activity",
      "granola_list_notes",
      "linear_list_issues",
      "last30days_core_extract",
      "last30days_validate",
      "reddit_search",
      "reddit_subreddit_search",
      "scrapecreators_tiktok",
      "x_search",
      "youtube_search",
      "artifact_create",
      "write_artifact",
      "dispatch_agent",
    ];
    const safe = canonicalizeToolNames(bare).map(toLlmToolName);
    expect(new Set(safe).size).toBe(safe.length);
    for (const name of safe) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});

describe("canonicalizeToolNames (CL-2145)", () => {
  it("prefixes a package tool with its factory id", () => {
    expect(canonicalizeToolNames(["granola_list_notes"])).toEqual([
      "@workbench/tools-granola/granola:granola_list_notes",
    ]);
  });

  it("maps web_search to the exa package, not a local runner", () => {
    expect(canonicalizeToolNames(["web_search"])).toEqual([
      "@workbench/tools-exa/exa:web_search",
    ]);
  });

  it("uses the last30days /core factory id for its tools", () => {
    expect(canonicalizeToolNames(["last30days_validate"])).toEqual([
      "@workbench/tools-last30days/core:last30days_validate",
    ]);
  });

  it("maps last30days_workflow_brief to the core package", () => {
    expect(canonicalizeToolNames(["last30days_workflow_brief"])).toEqual([
      "@workbench/tools-last30days/core:last30days_workflow_brief",
    ]);
  });

  it("leaves local runner tools (mail/posix) unprefixed", () => {
    expect(
      canonicalizeToolNames(["mail_search", "read_file", "run_shell"]),
    ).toEqual(["mail_search", "read_file", "run_shell"]);
  });

  it("passes through names with no known package (no false prefixing)", () => {
    expect(canonicalizeToolNames(["granola_search"])).toEqual([
      "granola_search",
    ]);
  });

  it("produces names that match the sidecar authz resource at invoke time", () => {
    // The loader emits `<factoryId>:<name>` and authz checks `tool:<runtime name>`
    // (interchange inference/authz-extension). The grant seeded from a canonical
    // capability name must therefore equal that resource string.
    const [canonical] = canonicalizeToolNames(["granola_list_notes"]);
    const seededResource = `tool:${canonical}`;
    const runtimeResource =
      "tool:@workbench/tools-granola/granola:granola_list_notes";
    expect(seededResource).toBe(runtimeResource);
  });
});

describe("toolPackagesForCapabilities", () => {
  it("pins @workbench/tools-last30days when the workflow brief tool is declared", () => {
    const pins = toolPackagesForCapabilities(
      canonicalizeToolNames(["last30days_workflow_brief"]),
    );
    expect(pins).toEqual([
      { name: "@workbench/tools-last30days", version: "^0.1.0" },
    ]);
  });
});

describe("expandToolAliasGrants", () => {
  it("adds web_search when capabilities only list exa_search", () => {
    const expanded = expandToolAliasGrants(
      canonicalizeToolNames(["exa_search"]),
    );
    expect(expanded).toContain("@workbench/tools-exa/exa:exa_search");
    expect(expanded).toContain("@workbench/tools-exa/exa:web_search");
  });

  it("does not expand unrelated tools", () => {
    const expanded = expandToolAliasGrants(
      canonicalizeToolNames(["read_file", "granola_list_notes"]),
    );
    expect(expanded).toEqual([
      "read_file",
      "@workbench/tools-granola/granola:granola_list_notes",
    ]);
  });
});

describe("providersForToolPackages", () => {
  it("maps a credentialed package pin to its provider", () => {
    expect(
      providersForToolPackages([
        { name: "@workbench/tools-granola", version: "^0.1.0" },
      ]),
    ).toEqual(["granola"]);
  });

  it("dedupes packages that share a provider (reddit + scrapecreators)", () => {
    expect(
      providersForToolPackages([
        { name: "@workbench/tools-reddit", version: "^0.1.0" },
        { name: "@workbench/tools-scrapecreators", version: "^0.1.0" },
      ]),
    ).toEqual(["scrapecreators"]);
  });

  it("ignores keyless / hub-backed packages", () => {
    expect(
      providersForToolPackages([
        { name: "@workbench/tools-artifact", version: "^0.1.0" },
        { name: "@workbench/tools-hackernews", version: "^0.1.0" },
      ]),
    ).toEqual([]);
  });
});
