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

  // CL-3407: mail_send was added to Myra's base toolset for the chat persona.
  // The triage persona's allow-list is read-only by construction, so it must
  // stay excluded even though the base toolset now carries it.
  it("carries mail_send in the base toolset but excludes it from the triage loadout", () => {
    expect(PERSONAL_AGENT_BASE_TOOLS).toContain("mail_send");
    expect(carriesTool(MAILBOX_PERSONA_TOOLS, "mail_send")).toBe(false);
    expect(isMailboxReadOnlyTool("mail_send")).toBe(false);
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

  // CL-3364: triage volume runs in the hundreds/day, so turn 1 advertises only
  // the platform core plus the internal-lookup tools the triage prompt calls
  // for (relationship/deal, recent calls, open work) — every research/social/
  // third-party tool (web search, Notion, Vercel, Firecrawl, GitHub, YouTube,
  // Reddit, Bluesky, X, HackerNews, Polymarket, ...) is dropped.
  it("shrinks to exactly the platform core plus the read-essential lookups", () => {
    const bareNames = MAILBOX_PERSONA_TOOLS.map((name) =>
      name.slice(name.lastIndexOf(":") + 1),
    ).sort();
    expect(bareNames).toEqual(
      [
        "search_tools",
        "load_tools",
        "memory_load",
        "artifact_read",
        "artifact_list",
        "workflow_list_kinds",
        "search_skills",
        "load_skill",
        "list_skill_drafts",
        "load_skill_draft",
        "attio_search_records",
        "attio_get_record",
        "attio_query_records",
        "attio_list_objects",
        "granola_list_notes",
        "granola_get_note",
        "linear_list_issues",
        "linear_get_issue",
        "task_create",
      ].sort(),
    );
  });

  it("drops the research/social/third-party tools out of the advertised loadout", () => {
    for (const dropped of [
      "web_search",
      "exa_search",
      "notion_search",
      "vercel_list_projects",
      "firecrawl_search",
      "github_activity",
      "youtube_search",
      "reddit_search",
      "bluesky_search",
      "x_search",
      "hackernews_search",
      "polymarket_odds",
      "parse_file",
      "workflow_list_runs",
      "list_skills",
      "list_agents",
      "search_agents",
      "list_principals",
      "identity_get",
      "attio_list_tasks",
      "attio_get_task",
      "granola_list_folders",
      "linear_list_teams",
      "linear_list_users",
    ]) {
      expect(carriesTool(MAILBOX_PERSONA_TOOLS, dropped)).toBe(false);
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
