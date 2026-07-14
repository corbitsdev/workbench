import { describe, expect, it } from "bun:test";
import {
  friendlyToolResult,
  friendlyToolSummary,
  friendlyToolSummaryKnown,
  isCatalogMetaTool,
  isExternalIntegrationTool,
  integrationToolProviderKey,
  summarizeToolCalls,
  toolOperationKey,
} from "./friendly-tool-summary";
import { MYRA_TOOL_CATALOG } from "./dynamic-tools/catalog";
import { canonicalizeToolNames, toLlmToolName } from "./tool-names";
import type { ToolSummaryCall } from "./friendly-tool-summary";

function call(
  name: string,
  args?: Record<string, unknown>,
  extra?: Partial<ToolSummaryCall>,
): ToolSummaryCall {
  return {
    id: "tc_1",
    name,
    ...(args !== undefined ? { arguments: args } : {}),
    ...extra,
  };
}

describe("integrationToolProviderKey", () => {
  it("reads LLM and FQN provider segments", () => {
    expect(integrationToolProviderKey("attio__create_record")).toBe("attio");
    expect(integrationToolProviderKey("linear__list_issues")).toBe("linear");
    expect(
      integrationToolProviderKey(
        "@workbench/tools-linear/linear:linear_list_issues",
      ),
    ).toBe("linear");
  });

  it("uses load_tools package for the provider slug", () => {
    expect(
      integrationToolProviderKey("load_tools", { package: "attio" }),
    ).toBe("attio");
    expect(integrationToolProviderKey("load_tools", {})).toBeNull();
  });

  it("returns null for workbench-internal providers and local runners", () => {
    expect(integrationToolProviderKey("artifact__memory_save")).toBeNull();
    expect(integrationToolProviderKey("read_file")).toBeNull();
  });

  it("resolves bare integration op ids when the wire name has no prefix", () => {
    expect(integrationToolProviderKey("exa_search")).toBe("exa");
    expect(integrationToolProviderKey("linear_get_issue")).toBe("linear");
  });
});

describe("toolOperationKey", () => {
  it("takes the substring after the last colon in a fully-qualified name", () => {
    expect(
      toolOperationKey("@workbench/tools-granola/granola:granola_get_note"),
    ).toBe("granola_get_note");
  });

  it("returns the whole name when there is no colon", () => {
    expect(toolOperationKey("granola_get_note")).toBe("granola_get_note");
  });

  it("normalizes LLM double-underscore names to bare phrase keys", () => {
    expect(toolOperationKey("attio__create_record")).toBe(
      "attio_create_record",
    );
    expect(toolOperationKey("exa__search")).toBe("exa_search");
    // skills tools are not named skills_*; bare is search_skills
    expect(toolOperationKey("skills__search_skills")).toBe("search_skills");
    expect(toolOperationKey("skills__list_skills")).toBe("list_skills");
  });
});

describe("friendlyToolSummary", () => {
  it("maps a known operation to its friendly verb phrase", () => {
    expect(
      friendlyToolSummary(
        call("@workbench/tools-granola/granola:granola_get_note"),
      ),
    ).toBe("Loading a transcript");
    expect(
      friendlyToolSummary(
        call("@workbench/tools-linear/linear:linear_list_issues"),
      ),
    ).toBe("Looking through Linear issues");
    expect(
      friendlyToolSummary(
        call("@workbench/tools-granola/granola:granola_list_notes"),
      ),
    ).toBe("Finding recent meetings");
  });

  it("interpolates a query argument when present", () => {
    expect(
      friendlyToolSummary(
        call("@workbench/tools-exa/exa:exa_search", { query: "minimax m3" }),
      ),
    ).toBe("Searching the web for minimax m3");
  });

  it("interpolates a url argument for firecrawl_scrape", () => {
    expect(
      friendlyToolSummary(
        call("@workbench/tools-firecrawl/firecrawl:firecrawl_scrape", {
          url: "https://example.com",
        }),
      ),
    ).toBe("Reading https://example.com");
  });

  it("phrases attio_create_record with the company name when values carry one", () => {
    expect(
      friendlyToolSummary(
        call("attio__create_record", {
          object: "companies",
          values: { name: "Tribe Capital", domains: ["tribecap.com"] },
        }),
      ),
    ).toBe("Creating an Attio record for Tribe Capital");
  });

  it("phrases attio_create_record with the object type when no name is present", () => {
    expect(
      friendlyToolSummary(
        call("@workbench/tools-attio/attio:attio_create_record", {
          object: "companies",
        }),
      ),
    ).toBe("Creating an Attio companies record");
  });

  it("falls back to the static record phrase when attio_create_record has no object", () => {
    expect(
      friendlyToolSummary(
        call("@workbench/tools-attio/attio:attio_create_record"),
      ),
    ).toBe("Creating an Attio record");
  });

  it("phrases attio_query_records with nameContains and object", () => {
    expect(
      friendlyToolSummary(
        call("attio__query_records", {
          object: "companies",
          nameContains: "Acme",
        }),
      ),
    ).toBe("Searching Attio companies for Acme");
  });

  it("matches LLM double-underscore names to the same phrases as bare names", () => {
    expect(friendlyToolSummary(call("attio__list_objects"))).toBe(
      "Browsing Attio objects",
    );
    expect(friendlyToolSummary(call("exa__search", { query: "hello" }))).toBe(
      "Searching the web for hello",
    );
  });

  it("exposes the recognized phrase and null for unknown tools via friendlyToolSummaryKnown", () => {
    // Recognized tool: returns the same phrase friendlyToolSummary renders.
    expect(friendlyToolSummaryKnown(call("attio__list_objects"))).toBe(
      "Browsing Attio objects",
    );
    // Unrecognized tool: null (not the soft "Working on …" fallback), so callers
    // can choose their own fallback without pattern-matching the label text.
    expect(
      friendlyToolSummaryKnown(call("totally_unknown_xyz_tool")),
    ).toBeNull();
    expect(friendlyToolSummary(call("totally_unknown_xyz_tool"))).toBe(
      "Working on totally unknown xyz tool",
    );
  });

  it("humanizes search_tools and load_tools without exposing raw names", () => {
    const search = friendlyToolSummary(
      call("search_tools", { query: "crm companies" }, { id: "s1" }),
    );
    // Polished, rotated set — must mention the term and never the wire id.
    expect(search.toLowerCase()).toMatch(/crm companies/);
    expect(search).not.toMatch(/search_tools|__/);
    expect(search).not.toMatch(/_/);
    // Same seed always picks the same phrase.
    expect(
      friendlyToolSummary(
        call("search_tools", { query: "crm companies" }, { id: "s1" }),
      ),
    ).toBe(search);

    const load = friendlyToolSummary(
      call(
        "load_tools",
        {
          package: "attio",
          names: ["attio__create_record", "attio__query_records"],
        },
        { id: "l1" },
      ),
    );
    expect(load.toLowerCase()).toMatch(/attio/);
    expect(load).not.toMatch(/load_tools|__/);
    expect(load).not.toMatch(/_/);

    const loadOne = friendlyToolSummary(
      call("load_tools", { names: ["attio__create_record"] }, { id: "l2" }),
    );
    expect(loadOne).not.toMatch(/attio__/);
    expect(loadOne).not.toMatch(/_/);
  });

  it("flags search_tools / load_tools as catalog meta-tools", () => {
    expect(isCatalogMetaTool("search_tools")).toBe(true);
    expect(isCatalogMetaTool("load_tools")).toBe(true);
    expect(isCatalogMetaTool("attio__create_record")).toBe(false);
  });

  it("classifies outside-service tools as external and workbench plumbing as internal", () => {
    expect(isExternalIntegrationTool("attio__create_record")).toBe(true);
    expect(isExternalIntegrationTool("exa__search")).toBe(true);
    expect(
      isExternalIntegrationTool("@workbench/tools-exa/exa:exa_search"),
    ).toBe(true);
    expect(isExternalIntegrationTool("artifact__memory_save")).toBe(false);
    expect(
      isExternalIntegrationTool(
        "@workbench/tools-artifact/artifact:memory_save",
      ),
    ).toBe(false);
    // Local runners stay internal; bare integration ops attribute by prefix.
    expect(isExternalIntegrationTool("read_file")).toBe(false);
    expect(isExternalIntegrationTool("ask_principal")).toBe(false);
    expect(isExternalIntegrationTool("exa_search")).toBe(true);
    // Identity/roster and compose presets are workbench plumbing too.
    expect(isExternalIntegrationTool("agents__list_agents")).toBe(false);
    expect(isExternalIntegrationTool("compose__ab_preset_compose")).toBe(false);
  });

  it("classifies the LLM-facing runtime names of internal plumbing as internal", () => {
    // The chat surface sees toLlmToolName(canonicalizeToolNames(...)) output,
    // not bare definition names — the classifier must hold at that seam.
    const internal = ["memory_save", "write_artifact", "workflow_start"];
    for (const llmName of canonicalizeToolNames(internal).map(toLlmToolName)) {
      expect(isExternalIntegrationTool(llmName)).toBe(false);
    }
    const external = ["attio_create_record", "exa_search", "linear_get_issue"];
    for (const llmName of canonicalizeToolNames(external).map(toLlmToolName)) {
      expect(isExternalIntegrationTool(llmName)).toBe(true);
    }
  });

  it("falls back to the static phrase when an interpolating op has no useful arg", () => {
    expect(
      friendlyToolSummary(call("@workbench/tools-exa/exa:exa_search")),
    ).toBe("Searching the web");
    expect(
      friendlyToolSummary(
        call("@workbench/tools-exa/exa:exa_search", { query: "   " }),
      ),
    ).toBe("Searching the web");
  });

  it("falls back to a present-participle phrase without snake_case or Title Case tool ids", () => {
    const result = friendlyToolSummary(
      call("@workbench/tools-mystery/mystery:mystery_do_thing"),
    );
    expect(result).toBe("Working on mystery do thing");
    expect(result).not.toMatch(/_/);
    expect(result).not.toBe("Mystery Do Thing");
    expect(result).not.toBe("Mystery do thing");
  });

  it("falls back using the operation key, not the full name", () => {
    const result = friendlyToolSummary(
      call("@workbench/tools-x/unknown:some_new_op"),
    );
    expect(result).toBe("Working on some new op");
    expect(result).not.toContain("@workbench");
    expect(result).not.toContain("/");
    expect(result).not.toMatch(/_/);
  });
});

/**
 * Soft-fallback reconstruction of the private softFallback() helper. Used only
 * to assert that catalog tools never land on it (CL-3268 drift gate).
 */
function softFallbackSentence(name: string): string {
  const key = toolOperationKey(name);
  const words = key
    .split("__")
    .join("_")
    .split(/[-_]+/u)
    .filter((w) => w.length > 0);
  if (words.length === 0) return "Working on a task";
  return `Working on ${words.join(" ").toLowerCase()}`;
}

describe("friendlyToolResult", () => {
  it("summarizes a JSON array as a result count", () => {
    expect(
      friendlyToolResult(
        call("attio__query_records", undefined, {
          result: JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]),
        }),
      ),
    ).toBe("Found 3 results");
  });

  it("summarizes an empty array", () => {
    expect(
      friendlyToolResult(
        call("exa__search", undefined, { result: JSON.stringify([]) }),
      ),
    ).toBe("No results");
  });

  it("returns null, never filler, for unrecognized result shapes", () => {
    // The formatter's contract: content or null. A generic "Done" would make
    // the chat render an expand chevron that opens onto nothing.
    const shapes = [
      JSON.stringify({ id: { record_id: "rec_1" }, values: { name: "Acme" } }),
      JSON.stringify({ ok: true }),
      JSON.stringify({ loaded: true }),
      JSON.stringify({ id: "rec_9" }),
      JSON.stringify({ some: { nested: "unknown" }, shape: 4 }),
      `{"truncated": "${"x".repeat(200)}`,
      "x".repeat(200),
    ];
    for (const result of shapes) {
      expect(
        friendlyToolResult(call("attio__create_record", undefined, { result })),
      ).toBeNull();
    }
  });

  it("keeps real outcomes for recognized shapes", () => {
    expect(
      friendlyToolResult(
        call("attio__create_record", undefined, {
          result: JSON.stringify({ deduped: true }),
        }),
      ),
    ).toBe("Already exists — skipped create");
    expect(
      friendlyToolResult(
        call("exa__search", undefined, { result: "short plain text" }),
      ),
    ).toBe("short plain text");
  });

  it("capitalizes provider names in load_tools phrases and never says 'Getting that ready'", () => {
    for (const id of ["l1", "l2", "l3", "l4", "l5"]) {
      const withPkg = friendlyToolSummary(
        call("load_tools", { package: "attio" }, { id }),
      );
      // Every package phrase embeds the display name — lowercase never leaks.
      expect(withPkg).toContain("Attio");
      expect(withPkg).not.toMatch(/\battio\b/);
      const single = friendlyToolSummary(
        call("load_tools", { names: ["attio__create_record"] }, { id }),
      );
      expect(single).not.toBe("Getting that ready");
      const idle = friendlyToolSummary(call("load_tools", {}, { id }));
      expect(idle).not.toBe("Getting that ready");
    }
  });

  it("uses stylized casing for brands plain capitalization gets wrong", () => {
    for (const id of ["s1", "s2", "s3"]) {
      expect(
        friendlyToolSummary(
          call("load_tools", { package: "scrapecreators" }, { id }),
        ),
      ).toContain("ScrapeCreators");
      expect(
        friendlyToolSummary(call("load_tools", { package: "youtube" }, { id })),
      ).toContain("YouTube");
      expect(
        friendlyToolSummary(call("load_tools", { package: "github" }, { id })),
      ).toContain("GitHub");
    }
  });

  it("summarizes a tools list from search_tools", () => {
    expect(
      friendlyToolResult(
        call("search_tools", undefined, {
          result: JSON.stringify({
            tools: [{ name: "a" }, { name: "b" }],
          }),
        }),
      ),
    ).toBe("Found 2 tools");
  });

  it("returns a short error message without JSON for failed calls", () => {
    expect(
      friendlyToolResult(
        call("attio__create_record", undefined, {
          isError: true,
          result: "No matching grants for tool:attio_create_record/invoke",
        }),
      ),
    ).toContain("No matching grants");
  });

  it("returns null while the call is still pending", () => {
    expect(friendlyToolResult(call("attio__create_record"))).toBeNull();
  });
});

describe("CL-3268 catalog phrase coverage", () => {
  it("every catalog tool has a hand-authored phrase (not soft fallback)", () => {
    const missing: string[] = [];
    for (const entry of MYRA_TOOL_CATALOG) {
      for (const tool of entry.tools) {
        const phrase = friendlyToolSummary({ id: "", name: tool.name });
        if (phrase === softFallbackSentence(tool.name) || /_/.test(phrase)) {
          missing.push(`${tool.name} => ${phrase}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("search_tools catalog descriptions are human phrases, not bare wire labels", () => {
    for (const entry of MYRA_TOOL_CATALOG) {
      for (const tool of entry.tools) {
        expect(tool.description).not.toMatch(/__/);
        expect(tool.description).not.toMatch(/_/);
        // Description is the no-args friendly phrase (not "attio query records").
        expect(tool.description).toBe(
          friendlyToolSummary({ id: "", name: tool.name }),
        );
      }
    }
  });
});

describe("summarizeToolCalls", () => {
  const q = (name: string): ToolSummaryCall => call(name);

  it("returns an empty string for no calls", () => {
    expect(summarizeToolCalls([])).toBe("");
  });

  it("excludes catalog meta-tools from the roll-up", () => {
    expect(
      summarizeToolCalls([
        call("search_tools", { query: "crm" }),
        call("load_tools", { package: "attio" }),
        call("attio__query_records"),
      ]),
    ).toBe("Searched Attio");
  });

  it("rolls up multiple families, ordered by first appearance, with counts", () => {
    const calls = [
      q("@workbench/tools-attio/attio:attio_search_records"),
      q("@workbench/tools-attio/attio:attio_get_record"),
      q("@workbench/tools-attio/attio:attio_get_record"),
      q("@workbench/tools-attio/attio:attio_get_record"),
      q("@workbench/tools-attio/attio:attio_get_record"),
      q("@workbench/tools-attio/attio:attio_query_records"),
      q("@workbench/tools-granola/granola:granola_list_notes"),
      q("@workbench/tools-granola/granola:granola_get_note"),
      q("@workbench/tools-granola/granola:granola_get_note"),
      q("@workbench/tools-granola/granola:granola_get_note"),
      q("@workbench/tools-granola/granola:granola_get_note"),
      q("@workbench/tools-linear/linear:linear_list_issues"),
      q("@workbench/tools-linear/linear:linear_get_issue"),
    ];
    expect(summarizeToolCalls(calls)).toBe(
      "Searched Attio 6×, read 5 notes, and checked Linear 2×",
    );
  });

  it("rolls up LLM double-underscore names into the same families", () => {
    const calls = [
      q("attio__search_records"),
      q("attio__get_record"),
      q("granola__get_note"),
    ];
    expect(summarizeToolCalls(calls)).toBe("Searched Attio 2× and read 1 note");
  });

  it('joins exactly two families with "and" and no comma', () => {
    const calls = [
      q("@workbench/tools-attio/attio:attio_get_record"),
      q("@workbench/tools-attio/attio:attio_get_record"),
      q("@workbench/tools-linear/linear:linear_get_issue"),
    ];
    expect(summarizeToolCalls(calls)).toBe(
      "Searched Attio 2× and checked Linear",
    );
  });

  it("omits the count suffix for a single call in a repeated-verb family", () => {
    expect(
      summarizeToolCalls([q("@workbench/tools-attio/attio:attio_get_record")]),
    ).toBe("Searched Attio");
  });

  it("uses a singular noun for one counted-noun call", () => {
    expect(
      summarizeToolCalls([
        q("@workbench/tools-granola/granola:granola_get_note"),
      ]),
    ).toBe("Read 1 note");
  });

  it("pluralizes a counted-noun family", () => {
    const calls = [
      q("@workbench/tools-granola/granola:granola_get_note"),
      q("@workbench/tools-granola/granola:granola_list_notes"),
    ];
    expect(summarizeToolCalls(calls)).toBe("Read 2 notes");
  });

  it("falls back to a humanized family name for an unknown family", () => {
    const calls = [
      q("@acme/tools-widget/widget:widget_poke"),
      q("@acme/tools-widget/widget:widget_poke"),
    ];
    expect(summarizeToolCalls(calls)).toBe("Widget 2×");
  });
});

describe("summarizeToolCalls styles", () => {
  const attio = (n: number): ToolSummaryCall[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `a${i}`,
      name: "@workbench/tools-attio/attio:attio_get_record",
      result: "ok",
    }));
  const notes = (n: number): ToolSummaryCall[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `g${i}`,
      name: "@workbench/tools-granola/granola:granola_get_note",
      result: "ok",
    }));
  const linear = (result: string): ToolSummaryCall => ({
    id: "l1",
    name: "@workbench/tools-linear/linear:linear_list_issues",
    result,
  });

  it('natural style spells two as "twice"', () => {
    expect(summarizeToolCalls(attio(2), "natural")).toBe(
      "Searched Attio twice",
    );
  });

  it('natural style spells larger counts as "N times"', () => {
    expect(summarizeToolCalls(attio(6), "natural")).toBe(
      "Searched Attio 6 times",
    );
  });

  it("varied style swaps in the alternate verb", () => {
    expect(summarizeToolCalls([...attio(6), ...notes(5)], "varied")).toBe(
      "Combed Attio 6 times and skimmed 5 notes",
    );
  });

  it("detail style surfaces a high-priority Linear issue from the result", () => {
    const calls = [
      linear(
        JSON.stringify([
          { id: "a", priority: "High" },
          { id: "b", priority: "Low" },
        ]),
      ),
    ];
    expect(summarizeToolCalls(calls, "detail")).toBe(
      "Found 2 Linear issues (one high-priority)",
    );
  });

  it("detail style falls back to the plain clause when the result is not parseable", () => {
    expect(
      summarizeToolCalls(
        [linear("not json"), linear("also not json")],
        "detail",
      ),
    ).toBe("Checked Linear twice");
  });

  it("detail style falls back when the JSON is valid but the wrong shape", () => {
    // Valid JSON, but neither an issue array nor a { issues } envelope — the
    // arktype parse rejects it and the clause degrades to plain.
    const calls = [
      linear(JSON.stringify({ unexpected: "shape" })),
      linear(JSON.stringify(42)),
    ];
    expect(summarizeToolCalls(calls, "detail")).toBe("Checked Linear twice");
  });

  it("detail style reads the { issues } envelope form", () => {
    const calls = [
      linear(JSON.stringify({ issues: [{ id: "a", priority: 2 }] })),
    ];
    expect(summarizeToolCalls(calls, "detail")).toBe(
      "Found 1 Linear issue (one high-priority)",
    );
  });

  it("detail style treats a high-name priority object as high-priority", () => {
    const calls = [
      linear(JSON.stringify([{ id: "a", priority: { name: "Urgent" } }])),
    ];
    expect(summarizeToolCalls(calls, "detail")).toBe(
      "Found 1 Linear issue (one high-priority)",
    );
  });

  it("detail style does not count a numeric nested priority name as high", () => {
    // A nested `{ name }` is a human label, never the 1/2 numeric scale; a numeric
    // value there is an unexpected shape, so the parse rejects it and the clause
    // degrades to plain rather than mistaking it for an Urgent/High priority.
    const calls = [
      linear(JSON.stringify([{ id: "a", priority: { name: 1 } }])),
    ];
    expect(summarizeToolCalls(calls, "detail")).toBe("Checked Linear");
  });

  it("mixed style combines varied verbs, natural counts, and detail", () => {
    const calls = [
      ...attio(6),
      ...notes(5),
      linear(
        JSON.stringify([
          { id: "a", priority: "Urgent" },
          { id: "b", priority: "Medium" },
        ]),
      ),
    ];
    expect(summarizeToolCalls(calls, "mixed")).toBe(
      "Combed Attio 6 times, skimmed 5 notes, and found 2 Linear issues (one high-priority)",
    );
  });
});
