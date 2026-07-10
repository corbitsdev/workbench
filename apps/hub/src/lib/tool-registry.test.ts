import { describe, expect, it } from "bun:test";
import {
  APPROVAL_REQUIRED_BARE_NAMES,
  isApprovalRequiredBare,
} from "@workbench/agents";
import {
  buildToolDefinitions,
  getToolNamesFromCapabilities,
  KNOWN_TOOLS,
  KNOWN_TOOL_SUMMARIES,
} from "./tool-registry";

describe("tool registry", () => {
  it("builds Interchange-owned POSIX tool definitions and the artifact link tool", () => {
    const definitions = buildToolDefinitions([
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "artifact_link_file",
    ]);

    expect(definitions.map((definition) => definition.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
      "artifact_link_file",
    ]);
  });

  it("canonicalizes bare package tool names from capabilities for grant reconcile", () => {
    expect(
      getToolNamesFromCapabilities({
        tools: [
          "web_search",
          "read_file",
          "@workbench/tools-exa/exa:exa_search",
        ],
      }),
    ).toEqual([
      "@workbench/tools-exa/exa:web_search",
      "read_file",
      "@workbench/tools-exa/exa:exa_search",
    ]);
  });

  it("expands exa_search to include the web_search grant alias", () => {
    expect(getToolNamesFromCapabilities({ tools: ["exa_search"] })).toEqual([
      "@workbench/tools-exa/exa:exa_search",
      "@workbench/tools-exa/exa:web_search",
    ]);
  });

  it("lists artifact_link_file as a Workbench tool", () => {
    expect(KNOWN_TOOL_SUMMARIES).toContainEqual(
      expect.objectContaining({
        name: "artifact_link_file",
        providerName: "workbench",
      }),
    );
  });

  it("every approval-required tool present in KNOWN_TOOLS is classified write", () => {
    // Approval ⊆ write. Internal writes (memory, artifacts, …) stay write
    // without opening ReviewGate — do not invert this to write ⊆ approval.
    for (const bare of APPROVAL_REQUIRED_BARE_NAMES) {
      const entry = KNOWN_TOOLS[bare];
      if (entry === undefined) continue;
      expect(entry.sideEffect).toBe("write");
      expect(isApprovalRequiredBare(bare)).toBe(true);
    }
  });

  it("does not force approval on internal durable writes", () => {
    for (const name of [
      "memory_save",
      "artifact_create",
      "artifact_write",
      "write_artifact",
      "dispatch_agent",
      "identity_set",
      "skill_draft",
    ] as const) {
      const entry = KNOWN_TOOLS[name];
      if (entry === undefined) continue;
      expect(entry.sideEffect).toBe("write");
      expect(isApprovalRequiredBare(name)).toBe(false);
    }
  });
});
