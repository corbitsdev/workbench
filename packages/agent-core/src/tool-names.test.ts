/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  canonicalizeStepToolName,
  canonicalizeToolNames,
  expandToolAliasGrants,
  LOCAL_RUNNER_TOOL_NAMES,
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

  // CL-2656: task/note tools must canonicalize + map to the grant name that
  // matched nothing in prod ("tool:attio__list_tasks/invoke").
  it("maps the attio task/note tools to their LLM-safe grant names", () => {
    expect(
      canonicalizeToolNames(["attio_list_tasks"]).map(toLlmToolName),
    ).toEqual(["attio__list_tasks"]);
    expect(
      canonicalizeToolNames([
        "attio_get_task",
        "attio_update_task",
        "attio_create_note",
      ]).map(toLlmToolName),
    ).toEqual(["attio__get_task", "attio__update_task", "attio__create_note"]);
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
      "vercel_deploy_static_file",
      "vercel_deploy_artifact",
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

  it("prefixes a prospect-engine tool with its factory id (regression: build order must not bake a bare name)", () => {
    expect(
      canonicalizeToolNames(["prospect_engine_extract_list_org_ids"]),
    ).toEqual([
      "@workbench/tools-prospect-engine/core:prospect_engine_extract_list_org_ids",
    ]);
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

describe("canonicalizeStepToolName (fail-closed on unresolvable step tool)", () => {
  it("prefixes a real package tool exactly like canonicalizeToolNames", () => {
    expect(canonicalizeStepToolName("render", "granola_list_notes")).toBe(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
  });

  it("passes through the explicit local-runner names unchanged", () => {
    expect(canonicalizeStepToolName("notify", "mail_send")).toBe("mail_send");
    expect(canonicalizeStepToolName("notify", "mail_reply")).toBe("mail_reply");
    expect(canonicalizeStepToolName("check", "mail_search")).toBe(
      "mail_search",
    );
    expect(canonicalizeStepToolName("check", "mail_read")).toBe("mail_read");
    expect(canonicalizeStepToolName("check", "mail_wait")).toBe("mail_wait");
  });

  it("throws, naming the step and the unresolvable tool, for a typo'd/retired name", () => {
    expect(() =>
      canonicalizeStepToolName(
        "extractOrgIds",
        "prospect_engine_extract_list_org_id",
      ),
    ).toThrow(/extractOrgIds/);
    expect(() =>
      canonicalizeStepToolName(
        "extractOrgIds",
        "prospect_engine_extract_list_org_id",
      ),
    ).toThrow(/prospect_engine_extract_list_org_id/);
  });

  it("throws for a retired posix local-runner name (no longer served by the sidecar)", () => {
    expect(() => canonicalizeStepToolName("readStep", "read_file")).toThrow(
      /read_file/,
    );
  });

  it("does not include the retired posix names in the explicit local-runner set", () => {
    expect(LOCAL_RUNNER_TOOL_NAMES.has("read_file")).toBe(false);
    expect(LOCAL_RUNNER_TOOL_NAMES.has("run_shell")).toBe(false);
    expect(LOCAL_RUNNER_TOOL_NAMES.has("mail_send")).toBe(true);
  });

  it("includes all five interchange mail tools, not just the write pair", () => {
    expect([...LOCAL_RUNNER_TOOL_NAMES].sort()).toEqual([
      "mail_read",
      "mail_reply",
      "mail_search",
      "mail_send",
      "mail_wait",
    ]);
  });
});

describe("toolPackagesForCapabilities", () => {
  // CL-2597: gamma_list_templates was unreachable from workflow steps because
  // it canonicalized to the credentialed gamma factory, whose loaded bundle
  // excludes it. It must map to the hub-backed gamma-templates factory AND
  // still pin the @workbench/tools-gamma tarball.
  it("maps gamma_list_templates to the hub-backed gamma-templates factory", () => {
    const canonical = canonicalizeToolNames(["gamma_list_templates"]);
    expect(canonical).toEqual([
      "@workbench/tools-gamma/gamma-templates:gamma_list_templates",
    ]);
    expect(toolPackagesForCapabilities(canonical)).toEqual([
      { name: "@workbench/tools-gamma", version: "^0.1.0" },
    ]);
  });

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
        { name: "@workbench/tools-vercel", version: "^0.1.0" },
      ]),
    ).toEqual(["granola", "vercel"]);
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

describe("workflow tools round-trip to a package pin (CL-3074 regression)", () => {
  // A deterministicToolStep names a tool by its bare name; the deploy canonicalizes
  // it and derives the package pin from the capability. A tool missing from the
  // registry stays bare, resolves to NO pin, and the sidecar never loads its
  // package — the step then throws "tool not found" at run time. Guard every tool
  // a shipped workflow actually names.
  const WORKFLOW_TOOLS = [
    "ab_preset_quorum",
    "ab_preset_compose",
    "artifact_create",
  ];

  for (const tool of WORKFLOW_TOOLS) {
    it(`${tool} canonicalizes to a prefixed name and yields a package pin`, () => {
      const [canonical] = canonicalizeToolNames([tool]);
      expect(canonical).toContain(":");
      expect(canonical).not.toBe(tool);
      expect(toolPackagesForCapabilities([tool]).length).toBeGreaterThan(0);
    });
  }
});
