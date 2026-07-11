import { describe, expect, it } from "bun:test";
import { threadPersona } from "./thread";
import { mailboxPersona } from "./mailbox";
import { MyraPersonaSchema } from "./persona";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
} from "../core/definition";
import { buildPersonalAgentSystemPrompt } from "../core/prompt";

// Tools that mutate external state or Myra's own memory. The mailbox triage
// persona is prepare-only, so none of these may appear in its loadout — this is
// the guard that keeps the triage session from taking an irreversible action.
const WRITE_TOOLS = [
  "memory_save",
  "artifact_create",
  "artifact_write",
  "attio_update_task",
  "attio_create_note",
  "identity_set",
  "skill_draft",
  "workflow_start",
  "workflow_signal",
  "vercel_deploy_static_file",
  "vercel_deploy_artifact",
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

  it("exposes a read-only tool subset with no write tools", () => {
    for (const write of WRITE_TOOLS) {
      expect(carriesTool(mailboxPersona.toolNames, write)).toBe(false);
    }
  });

  it("draws every tool from Myra's base toolset", () => {
    for (const tool of mailboxPersona.toolNames) {
      expect(PERSONAL_AGENT_BASE_TOOLS).toContain(tool);
    }
  });

  it("still carries read tools it needs to gather context", () => {
    for (const read of ["memory_load", "search_tools"]) {
      expect(carriesTool(mailboxPersona.toolNames, read)).toBe(true);
    }
  });
});
