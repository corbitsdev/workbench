/// <reference types="bun" />
import { describe, expect, it } from "bun:test";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_TRIAGE_NAME,
  PERSONAL_AGENT_TRIAGE_MODEL_CONFIG,
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

  it("grants the dynamic catalog tools", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain("search_tools");
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain("load_tools");
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
      "@workbench/tools-linear/linear:linear_create_issue",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_query_records",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-vercel/vercel:vercel_list_projects",
    );
  });

  // CL-2656: the attio task/note tools are registered in ATTIO_HUB_TOOLS and
  // exposed to Myra's model, so they must also be granted here — otherwise the
  // model calls them and authz rejects with "No matching grants".
  it("includes the attio task/note tools (prefixed)", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_list_tasks",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_get_task",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_update_task",
    );
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain(
      "@workbench/tools-attio/attio:attio_create_note",
    );
  });

  // CL-3407: mail_send is the one mail tool restored, so Myra can send a note
  // to a teammate's mailbox. Every other mail tool (mail_reply, mail_search,
  // mail_read, mail_wait) stays out — chat-Myra initiates notes, it does not
  // triage an inbox.
  it("carries mail_send but no other mail tool", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain("mail_send");
    for (const tool of PERSONAL_AGENT_BASE_TOOLS) {
      if (tool.startsWith("mail_")) {
        expect(tool).toBe("mail_send");
      }
    }
  });
});

describe("PERSONAL_AGENT_TRIAGE_MODEL_CONFIG (CL-3364)", () => {
  it("names a distinct definition from Myra's own", () => {
    expect(PERSONAL_AGENT_TRIAGE_NAME).not.toBe(PERSONAL_AGENT_NAME);
  });

  it("pins the cheap flash model, not Myra's own chat model", () => {
    expect(PERSONAL_AGENT_TRIAGE_MODEL_CONFIG).toEqual({
      defaultModel: "deepseek-v4-flash",
    });
  });
});

describe("PERSONAL_AGENT_DEPLOY_PROMPT", () => {
  // Myra runs inference on kimi-k2.6 via the `openai-compatible` provider, so
  // her deployed prompt must render in Markdown (the non-Anthropic format),
  // never XML. A regression here (a hardcoded `{ xml: true }`) ships the wrong
  // section format to the model she actually runs on.
  it("renders in Markdown for the non-Anthropic provider she runs on", () => {
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain("## Role");
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain("## Operating-loop");
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).not.toContain("<role>");
  });

  it("carries the Chief of Staff identity without hardcoding tool names", () => {
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).toContain(
      "You are Myra, Chief of Staff",
    );
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).not.toContain("artifact_create");
    expect(PERSONAL_AGENT_DEPLOY_PROMPT).not.toContain("artifact_read");
  });
});
