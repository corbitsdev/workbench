import { describe, expect, test } from "bun:test";
import {
  MAILBOX_PERSONA_TOOLS,
  buildMailboxTriagePrompt,
  isMailboxReadOnlyTool,
  resolveMailboxLoadout,
} from "./mailbox";

describe("isMailboxReadOnlyTool", () => {
  test("admits task_create as the sole audited write", () => {
    expect(isMailboxReadOnlyTool("task_create")).toBe(true);
  });

  test("rejects every other write tool, including the rest of the tasks stack", () => {
    for (const write of [
      "task_update",
      "task_deploy",
      "memory_save",
      "artifact_create",
      "artifact_write",
      "workflow_start",
      "mail_send",
    ]) {
      expect(isMailboxReadOnlyTool(write)).toBe(false);
    }
  });
});

describe("MAILBOX_PERSONA_TOOLS", () => {
  test("carries task_create and only task_create as a write tool", () => {
    expect(MAILBOX_PERSONA_TOOLS).toContain("task_create");
    const nonReadOnly = MAILBOX_PERSONA_TOOLS.filter(
      (name) => !isMailboxReadOnlyTool(name),
    );
    expect(nonReadOnly).toEqual([]);
  });
});

describe("resolveMailboxLoadout", () => {
  test("prepare_only with tasks enabled (default) mounts task_create", () => {
    const loadout = resolveMailboxLoadout("prepare_only");
    expect(loadout.toolNames).toContain("task_create");
    expect(loadout.systemPrompt).toContain("task_create");
  });

  test("prepare_only with tasks disabled drops task_create from tools and prompt", () => {
    const loadout = resolveMailboxLoadout("prepare_only", false);
    expect(loadout.toolNames).not.toContain("task_create");
    expect(loadout.systemPrompt).not.toContain("task_create");
  });

  test("execute_with_gates with tasks disabled drops task_create from the full toolset", () => {
    const loadout = resolveMailboxLoadout("execute_with_gates", false);
    expect(loadout.toolNames).not.toContain("task_create");
  });

  test("execute_with_gates with tasks enabled (default) keeps task_create", () => {
    const loadout = resolveMailboxLoadout("execute_with_gates");
    expect(loadout.toolNames).toContain("task_create");
  });
});

describe("buildMailboxTriagePrompt", () => {
  test("includes the task-creation instruction when tasks are enabled", () => {
    const prompt = buildMailboxTriagePrompt("Myra", "prepare_only", true);
    expect(prompt).toContain("task_create");
  });

  test("omits the task-creation instruction when tasks are disabled", () => {
    const prompt = buildMailboxTriagePrompt("Myra", "prepare_only", false);
    expect(prompt).not.toContain("task_create");
  });
});
