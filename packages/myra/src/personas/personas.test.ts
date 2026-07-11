import { describe, expect, it } from "bun:test";
import { threadPersona } from "./thread";
import { isMailboxReadOnlyTool, mailboxPersona } from "./mailbox";
import { MyraPersonaSchema } from "./persona";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
} from "../core/definition";
import { buildPersonalAgentSystemPrompt } from "../core/prompt";

// Canonical catalogue of known write/mutating tools across Myra's base
// toolset. The mailbox triage persona is prepare-only, so none of these may
// ever appear in its loadout — this is the guard that keeps the triage
// session from taking an irreversible action, independent of how the
// allow-list predicate is implemented.
const WRITE_TOOLS = [
  "memory_save",
  "artifact_create",
  "artifact_write",
  "write_artifact",
  "artifact_link_file",
  "artifact_link_presentation",
  "artifact_link_gamma_presentation",
  "attio_update_task",
  "attio_create_note",
  "attio_create_record",
  "linear_create_issue",
  "notion_create_page",
  "identity_set",
  "skill_draft",
  "workflow_start",
  "workflow_signal",
  "vercel_deploy_static_file",
  "vercel_deploy_artifact",
  "mail_send",
];

const carriesTool = (toolNames: readonly string[], tool: string): boolean =>
  toolNames.some((name) => name === tool || name.endsWith(`:${tool}`));

describe("threadPersona", () => {
  it("conforms to the MyraPersona shape", () => {
    const parsed = MyraPersonaSchema(threadPersona);
    expect(parsed).toEqual(threadPersona);
  });

  it("is keyed 'thread'", () => {
    expect(threadPersona.key).toBe("thread");
  });

  it("exposes the exact current chat system prompt", () => {
    expect(threadPersona.systemPrompt).toBe(
      buildPersonalAgentSystemPrompt(PERSONAL_AGENT_NAME, { xml: true }),
    );
  });

  it("carries Myra's full base toolset unchanged", () => {
    expect(threadPersona.toolNames).toEqual(PERSONAL_AGENT_BASE_TOOLS);
  });
});

describe("mailboxPersona", () => {
  it("conforms to the MyraPersona shape", () => {
    const parsed = MyraPersonaSchema(mailboxPersona);
    expect(parsed).toEqual(mailboxPersona);
  });

  it("is keyed 'mailbox'", () => {
    expect(mailboxPersona.key).toBe("mailbox");
  });

  it("carries a non-empty triage system prompt", () => {
    expect(mailboxPersona.systemPrompt.length).toBeGreaterThan(0);
    expect(mailboxPersona.systemPrompt).toContain(PERSONAL_AGENT_NAME);
  });

  it("carries only tools the read-only allow predicate admits", () => {
    for (const tool of mailboxPersona.toolNames) {
      expect(isMailboxReadOnlyTool(tool)).toBe(true);
    }
  });

  it("carries none of the known write tools", () => {
    for (const write of WRITE_TOOLS) {
      expect(carriesTool(mailboxPersona.toolNames, write)).toBe(false);
    }
  });

  it("draws every tool from Myra's base toolset", () => {
    for (const tool of mailboxPersona.toolNames) {
      expect(PERSONAL_AGENT_BASE_TOOLS).toContain(tool);
    }
  });

  it("still carries the discovery and read tools it needs to gather context", () => {
    for (const read of [
      "search_tools",
      "load_tools",
      "memory_load",
      "artifact_read",
      "artifact_list",
    ]) {
      expect(carriesTool(mailboxPersona.toolNames, read)).toBe(true);
    }
  });
});
