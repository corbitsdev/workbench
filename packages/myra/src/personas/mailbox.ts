import { buildSystemPrompt, type PromptSection } from "@workbench/prompts";
import { CORBITS_VOCABULARY_SECTION } from "@workbench/agent-core/corbits-vocabulary";
import type { AgentAutonomy } from "@workbench/shared";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_PROMPT_FORMAT,
  PERSONAL_AGENT_TRIAGE_MODEL_CONFIG,
} from "../core/definition";

/**
 * Myra's inbound-mail triage loadout: the prompt and read-only tool posture a
 * per-item triage session mounts to classify one external message, plan a
 * response, and prepare a draft without taking irreversible action. The hub's
 * mailbox-triage service spawns an ephemeral Myra session per inbox item and
 * mounts `resolveMailboxLoadout(autonomy)` — prepare-only by default, or the
 * gated full toolset when the member opts into `execute_with_gates`.
 */

// Read verbs a bare tool name must carry (as a whole `_`-separated segment)
// to enter the triage loadout. Anything else — create/update/set/send/deploy/
// draft/start/signal and every verb not listed here — defaults OUT.
const READ_ONLY_NAME_PATTERN =
  /(^|_)(search|list|get|read|load|query|find)(_|$)/;

// Read-only grounding tools whose names carry no read verb. Kept deliberately
// short: a tool earns a place here only after a manual read-only audit.
//
// `task_create` is the sole audited EXCEPTION to "read-only": it is a write,
// but the one write triage's whole job is to produce — leaving a durable,
// unsent `waiting`-status task behind is the prepare-only output itself, not
// an irreversible action taken on the person's behalf (task_update/task_list
// and every other write stay excluded). See `resolveTriageTaskDefaultStatus`
// in apps/hub/src/tools/task-tools.ts for how a triage-created task is forced
// into `waiting` regardless of the member's autonomy setting.
const READ_ONLY_EXTRA_TOOLS = new Set([
  "parse_file",
  "firecrawl_scrape",
  "github_activity",
  "polymarket_odds",
  "scrapecreators_tiktok",
  "scrapecreators_instagram",
  "scrapecreators_threads",
  "scrapecreators_pinterest",
  "task_create",
]);

/**
 * Allow predicate for the triage loadout: a tool is admitted only when its
 * bare name (the segment after any `<factoryId>:` prefix) names a read
 * operation or sits on the audited read-only extras list. Because this is an
 * ALLOW-list, any new base tool defaults out of triage until its name matches
 * a read verb or it is explicitly audited in — a new write tool can never
 * leak in by omission.
 */
export function isMailboxReadOnlyTool(toolName: string): boolean {
  const bare = toolName.slice(toolName.lastIndexOf(":") + 1);
  return READ_ONLY_NAME_PATTERN.test(bare) || READ_ONLY_EXTRA_TOOLS.has(bare);
}

// The platform core Myra always advertises (CL-3190), minus its write members
// (memory_save, artifact_create, artifact_write, workflow_start) — catalog
// discovery plus the always-visible read primitives. `task_create` is added
// deliberately despite being a write — see the comment on
// `READ_ONLY_EXTRA_TOOLS` above; it is the sole write this loadout ever
// admits, and `isMailboxReadOnlyTool` is still what gates it in.
const PLATFORM_CORE_BARE_TOOLS = new Set([
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
  "task_create",
]);

/**
 * The read essentials the triage prompt's "knowledge" section actually
 * instructs gathering before judging a message: the sender/company
 * relationship (Attio), recent call history (Granola), and open work
 * (Linear). There is no dedicated mail-read tool in Myra's base toolset — the
 * inbound message is already the turn's content (see `buildTriageMessage` in
 * mailbox-triage.ts), not something triage calls a tool to fetch.
 */
const READ_ESSENTIAL_BARE_TOOLS = new Set([
  "attio_search_records",
  "attio_get_record",
  "attio_query_records",
  "attio_list_objects",
  "granola_list_notes",
  "granola_get_note",
  "linear_list_issues",
  "linear_get_issue",
]);

const MINIMAL_LOADOUT_BARE_TOOLS = new Set([
  ...PLATFORM_CORE_BARE_TOOLS,
  ...READ_ESSENTIAL_BARE_TOOLS,
]);

/**
 * Allow predicate for the minimal `prepare_only` loadout: read-only (the
 * existing safety net) AND on the curated minimal set. Triage volume runs in
 * the hundreds/day, so turn 1 advertises only the platform core plus the
 * handful of internal-lookup tools the prompt calls for — every research /
 * social / third-party tool in Myra's base toolset (web search, Notion,
 * Vercel, Firecrawl, GitHub, YouTube, Reddit, Bluesky, X, HackerNews,
 * Polymarket, ...) is dropped from the advertised list. Grants stay the full
 * base toolset (`capabilities.tools` on the triage agent definition) — the
 * intersection enforcement at launch already keeps an unadvertised tool from
 * being callable, so shrinking only the advertised list cannot widen access.
 */
function isMailboxMinimalTool(toolName: string): boolean {
  const bare = toolName.slice(toolName.lastIndexOf(":") + 1);
  return (
    isMailboxReadOnlyTool(toolName) && MINIMAL_LOADOUT_BARE_TOOLS.has(bare)
  );
}

/**
 * The triage loadout: the base toolset intersected with the minimal-loadout
 * allow predicate, so the mailbox persona can never advertise a tool Myra
 * does not otherwise carry, and cannot exceed the curated minimal set.
 */
export const MAILBOX_PERSONA_TOOLS: string[] =
  PERSONAL_AGENT_BASE_TOOLS.filter(isMailboxMinimalTool);

const PREPARE_ONLY_RULES = `You are prepare-only. Do not send mail, message anyone, create or change any record, start a workflow, or take any other irreversible action. If the right next step is one of those, name it in your plan and leave it for the person to approve — never do it yourself in this pass.`;

const EXECUTE_WITH_GATES_RULES = `You may carry the next step out yourself when your tools allow it. Every externally visible or irreversible action is gated behind the person's approval rail, so request it when it is the right next step — it will be reviewed before anything happens. Still lead with the classification and plan, and still prepare a draft whenever a reply is warranted.`;

/**
 * Fragment of the triage role sentence present verbatim in every mailbox
 * triage session's system prompt, regardless of autonomy — the only
 * structural signal available at the sidecar harness to identify a triage
 * launch. `agentConfig` at that seam carries no template/definition
 * name, only the resolved prompt, so this mirrors the existing
 * `resolveDynamicToolConfig` prompt-marker convention rather than adding a new
 * launch-time flag. The prompt builder below interpolates this constant so
 * the marker and the prompt cannot drift apart — a reworded role sentence
 * that forgot the marker would silently disable the triage budget director.
 */
const TRIAGE_SESSION_MARKER_FRAGMENT =
  "triaging a single inbound message that has just arrived";

/**
 * True when `systemPrompt` is a mailbox-triage session's prompt (either
 * autonomy variant of `buildMailboxTriagePrompt`). Used at the sidecar
 * harness to select the budget-capped director for ephemeral triage Myras
 * without threading a new launch-time signal through `agentConfig`.
 */
export function isTriageSessionPrompt(systemPrompt: string): boolean {
  return systemPrompt.includes(TRIAGE_SESSION_MARKER_FRAGMENT);
}

/**
 * The `(4)` task-creation instruction, present only when the member's
 * `tasksTriageCreate` toggle is on (default true — see
 * `packages/workbench-shared/src/preferences-registry.ts`). When the toggle
 * is off the tool is also absent from the mounted loadout
 * (`resolveMailboxLoadout`), so this doubles as the prompt-side half of that
 * gate rather than a second, driftable source of truth.
 */
function tasksSectionFor(tasksEnabled: boolean): string {
  if (!tasksEnabled) return "";
  return `(4) When the message is actionable — it needs a reply, a follow-up, or a hand-off — call \`task_create\` once with a short title. Set \`sourceRef\` to the \`Mailbox message id\` from the user message (exact string). Optionally add \`links\`: \`[{ "kind": "mail", "ref": "<same id>" }]\` — never invent \`mail:…\` prefixes or put non-http refs in \`kind: "url"\`. Skip \`task_create\` for messages that need no action.`;
}

export function buildMailboxTriagePrompt(
  name: string,
  autonomy: AgentAutonomy = "prepare_only",
  tasksEnabled = true,
  model: string = PERSONAL_AGENT_TRIAGE_MODEL_CONFIG.defaultModel,
): string {
  const actionRules =
    autonomy === "execute_with_gates"
      ? EXECUTE_WITH_GATES_RULES
      : PREPARE_ONLY_RULES;
  const sections: PromptSection[] = [
    {
      tag: "role",
      content: `You are ${name}, ${TRIAGE_SESSION_MARKER_FRAGMENT} for the person you work for. Your job is to understand it, decide what it needs, and prepare the response — not to send anything. You hold the company's context: who the sender is, the history with them, and what work is in flight. Use it to judge the message accurately. You run on the ${model} model, served through the Corbits platform.`,
    },
    CORBITS_VOCABULARY_SECTION,
    {
      tag: "task",
      content: `Do three things and stop. (1) Classify the message: what it is, who it is from, and how it relates to existing people, deals, or work. (2) Assess priority and what it needs — a reply, an internal action, a hand-off, or nothing. (3) Prepare a draft response the person can review and send themselves.

${actionRules}

${tasksSectionFor(tasksEnabled)}`,
    },
    {
      tag: "knowledge",
      content: `Ground the triage in what the company already knows. When the sender or subject names a person, company, or deal, look up the relationship, recent calls, and open work first, and lead with that internal picture. Your tools here are read-only and deliberately narrow: gather context, do not change it, and do not reach beyond the company's own records.`,
    },
    {
      tag: "output",
      content: `Return a concise triage: a one-line classification, the priority and why, the recommended next step, and a ready-to-send draft reply when a reply is warranted. Keep the draft in the person's voice and short. If the message needs no response, say so plainly and stop.`,
    },
    {
      tag: "honesty",
      content: `Your function list is the source of truth for what you can do — call a tool by the exact name it gives. If you are missing context you need, say what is missing rather than guessing. Never fabricate sender details, history, or facts, and never impersonate the person you work for. If you could not determine something, report it honestly.`,
    },
    {
      tag: "style",
      content: `- Plain, direct, no filler
- Lead with the classification and recommendation, then the reasoning
- No emojis unless the draft's context calls for matching the sender`,
    },
  ];

  return buildSystemPrompt(sections, PERSONAL_AGENT_PROMPT_FORMAT);
}

export type MailboxLoadout = {
  systemPrompt: string;
  toolNames: string[];
};

/**
 * The prompt + tool loadout a triage session mounts for a member's autonomy
 * setting. `prepare_only` is read-only (the audited allow-list) plus the sole
 * `task_create` exception; `execute_with_gates` mounts the full base toolset
 * with the gated-action prompt — writes still flow through the approval
 * rail, never around it. `tasksEnabled` is the member's `tasksTriageCreate`
 * preference (default true); false drops `task_create` from the mounted
 * tools in both branches and from the prompt's task-creation instruction, so
 * a member who opts out gets neither the capability nor the instruction to
 * use it.
 */
export function resolveMailboxLoadout(
  autonomy: AgentAutonomy,
  tasksEnabled = true,
  model: string = PERSONAL_AGENT_TRIAGE_MODEL_CONFIG.defaultModel,
): MailboxLoadout {
  if (autonomy === "execute_with_gates") {
    const toolNames = tasksEnabled
      ? PERSONAL_AGENT_BASE_TOOLS
      : PERSONAL_AGENT_BASE_TOOLS.filter(
          (name) => !name.endsWith("task_create"),
        );
    return {
      systemPrompt: buildMailboxTriagePrompt(
        PERSONAL_AGENT_NAME,
        autonomy,
        tasksEnabled,
        model,
      ),
      toolNames,
    };
  }
  const toolNames = tasksEnabled
    ? MAILBOX_PERSONA_TOOLS
    : MAILBOX_PERSONA_TOOLS.filter((name) => !name.endsWith("task_create"));
  return {
    systemPrompt: buildMailboxTriagePrompt(
      PERSONAL_AGENT_NAME,
      "prepare_only",
      tasksEnabled,
      model,
    ),
    toolNames,
  };
}
