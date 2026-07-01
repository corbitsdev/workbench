/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
} from "./definition";

describe("PERSONAL_AGENT_BASE_TOOLS (CL-1555, CL-2145)", () => {
  // Artifact tools are native packages, so capabilities carry the canonical
  // prefixed runtime name the loader emits — that is what the seeded grant must
  // match (CL-2145).
  it("includes artifact_create (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-artifact/artifact:artifact_create",
    );
  });

  it("includes artifact_read (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-artifact/artifact:artifact_read",
    );
  });

  it("includes artifact_write (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-artifact/artifact:artifact_write",
    );
  });

  it("includes artifact_list (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-artifact/artifact:artifact_list",
    );
  });

  // CL-2413: durable memory moved off the filesystem into the hub artifact
  // store, accessed via memory_load/memory_save. POSIX runner tools are dropped.
  it("includes the memory tools (prefixed, same factory as artifact)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-artifact/artifact:memory_load",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-artifact/artifact:memory_save",
    );
  });

  it("no longer carries POSIX filesystem tools", () => {
    for (const posix of [
      "read_file",
      "write_file",
      "edit_file",
      "search_files",
    ]) {
      expect(PERSONAL_AGENT_BASE_TOOLS).not.toContain(posix);
    }
  });

  // CL-2420: per-tool account identity for scoping "my X" queries.
  it("includes the identity tools (prefixed, tools-agents factory)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-agents/agents:identity_get",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-agents/agents:identity_set",
    );
  });

  it("includes the Exa web_search alias (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-exa/exa:web_search",
    );
  });

  it("includes the read-only Granola, Linear, Attio, and Vercel tools (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-linear/linear:linear_list_issues",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_query_records",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-vercel/vercel:vercel_list_projects",
    );
  });

  it("no longer carries the mail tools (removed in favor of direct domain tools)", () => {
    for (const tool of PERSONAL_AGENT_BASE_TOOLS) {
      expect(tool.startsWith("mail_")).toBe(false);
    }
  });
});

describe("PERSONAL_AGENT_DEPLOY_PROMPT (CL-2306)", () => {
  it("guides shared-document behavior without hardcoding tool names", () => {
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain(
      "Shared documents are versioned",
    );
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain(
      "load its content before responding",
    );
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).not.toContain("artifact_create");
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).not.toContain("artifact_read");
  });
});
