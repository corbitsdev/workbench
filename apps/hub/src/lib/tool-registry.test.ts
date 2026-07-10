import { describe, expect, it } from "bun:test";
import {
  APPROVAL_GATED_TOOL_NAMES,
  canonicalizeToolNames,
  toLlmToolName,
} from "@workbench/agents";
import { VERCEL_HUB_TOOLS } from "@workbench/tools-vercel";
import { VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS } from "../tools/vercel-deploy-artifact";
import {
  buildToolDefinitions,
  getToolNamesFromCapabilities,
  KNOWN_TOOLS,
  KNOWN_TOOL_SUMMARIES,
  type ToolEntry,
} from "./tool-registry";

/**
 * Approval-required tools may live in KNOWN_TOOLS (gallery coexistence)
 * and/or package hub maps that are not spread into KNOWN_TOOLS yet
 * (VERCEL_HUB_TOOLS, vercel_deploy_artifact hub entry). Resolve across
 * those maps so a missing entry fails the test instead of being skipped.
 * Avoids importing hub-backed-tools (circular with tool-registry).
 */
function resolveClassifiedEntry(bare: string): ToolEntry | undefined {
  return (
    KNOWN_TOOLS[bare] ??
    (VERCEL_HUB_TOOLS as Record<string, ToolEntry>)[bare] ??
    (VERCEL_DEPLOY_ARTIFACT_HUB_TOOLS as Record<string, ToolEntry>)[bare]
  );
}

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

  function gatedLlmName(bare: string): string {
    return toLlmToolName(canonicalizeToolNames([bare])[0] ?? bare);
  }

  it("every approval-gated external write is registered, classified write, and in the gated set", () => {
    // Approval ⊆ write. Internal writes (memory, artifacts, …) stay write
    // without opening ReviewGate — do not invert this to write ⊆ approval.
    for (const bare of [
      "attio_update_task",
      "attio_create_note",
      "gamma_create_from_template",
      "gamma_duplicate_presentation",
      "vercel_deploy_static_file",
      "vercel_deploy_artifact",
    ] as const) {
      const entry = resolveClassifiedEntry(bare);
      expect(entry).toBeDefined();
      expect(entry?.sideEffect).toBe("write");
      expect(APPROVAL_GATED_TOOL_NAMES.has(gatedLlmName(bare))).toBe(true);
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
      const entry = resolveClassifiedEntry(name);
      expect(entry).toBeDefined();
      expect(entry?.sideEffect).toBe("write");
      expect(APPROVAL_GATED_TOOL_NAMES.has(gatedLlmName(name))).toBe(false);
    }
  });
});
