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

  it("leaves local runner tools (posix) unprefixed", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain("read_file");
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain("search_files");
  });

  it("includes the Exa web_search alias (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-exa/exa:web_search",
    );
  });

  it("includes the read-only Granola, Linear, and Attio tools (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-granola/granola:granola_list_notes",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-linear/linear:linear_list_issues",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_query_records",
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
