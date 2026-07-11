import { describe, expect, it } from "bun:test";
import {
  buildMailboxTriagePrompt,
  isMailboxReadOnlyTool,
  MAILBOX_PERSONA_TOOLS,
  resolveMailboxLoadout,
} from "./mailbox";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
} from "../core/definition";

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

describe("MAILBOX_PERSONA_TOOLS", () => {
  it("carries only tools the read-only allow predicate admits", () => {
    for (const tool of MAILBOX_PERSONA_TOOLS) {
      expect(isMailboxReadOnlyTool(tool)).toBe(true);
    }
  });

  it("carries none of the known write tools", () => {
    for (const write of WRITE_TOOLS) {
      expect(carriesTool(MAILBOX_PERSONA_TOOLS, write)).toBe(false);
    }
  });

  it("draws every tool from Myra's base toolset", () => {
    for (const tool of MAILBOX_PERSONA_TOOLS) {
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
      expect(carriesTool(MAILBOX_PERSONA_TOOLS, read)).toBe(true);
    }
  });
});

describe("resolveMailboxLoadout", () => {
  it("resolves prepare_only to the read-only prompt and tool posture", () => {
    const loadout = resolveMailboxLoadout("prepare_only");
    expect(loadout.systemPrompt).toBe(
      buildMailboxTriagePrompt(PERSONAL_AGENT_NAME),
    );
    expect(loadout.toolNames).toEqual(MAILBOX_PERSONA_TOOLS);
    expect(loadout.systemPrompt).toContain("You are prepare-only");
  });

  it("resolves execute_with_gates to the full base toolset", () => {
    const loadout = resolveMailboxLoadout("execute_with_gates");
    expect(loadout.toolNames).toEqual(PERSONAL_AGENT_BASE_TOOLS);
  });

  it("swaps the prepare-only prohibition for the approval rail under execute_with_gates", () => {
    const loadout = resolveMailboxLoadout("execute_with_gates");
    expect(loadout.systemPrompt).not.toContain("You are prepare-only");
    expect(loadout.systemPrompt).toContain("approval");
    expect(loadout.systemPrompt).toContain(PERSONAL_AGENT_NAME);
  });
});
