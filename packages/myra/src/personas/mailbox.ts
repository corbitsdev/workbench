import { buildSystemPrompt, type PromptSection } from "@workbench/prompts";
import { CORBITS_VOCABULARY_SECTION } from "@workbench/agents/corbits-vocabulary";
import type { AgentAutonomy } from "@workbench/shared";
import type { MyraPersona } from "./persona";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_NAME,
} from "../core/definition";

/**
 * The mailbox persona is Myra triaging one inbound external message. It is
 * prepare-only: it classifies the message, plans a response, and prepares a
 * draft, but takes no external or irreversible action — its tool loadout is a
 * strict read-only subset of Myra's base toolset (no memory writes, no CRM
 * mutations, no sends, no workflow starts).
 *
 * The spawn path — a per-item, thread-style session launched from the hub's
 * inbound-mail hook, one Myra thread per inbox item — is not yet wired. This
 * module defines the persona shape only (prompt, rules, tool posture); the
 * spawn and draft-persistence wiring lands with the auto-triage work.
 */

// Read verbs a bare tool name must carry (as a whole `_`-separated segment)
// to enter the triage loadout. Anything else — create/update/set/send/deploy/
// draft/start/signal and every verb not listed here — defaults OUT.
const READ_ONLY_NAME_PATTERN =
  /(^|_)(search|list|get|read|load|query|find)(_|$)/;

// Read-only grounding tools whose names carry no read verb. Kept deliberately
// short: a tool earns a place here only after a manual read-only audit.
const READ_ONLY_EXTRA_TOOLS = new Set([
  "parse_file",
  "firecrawl_scrape",
  "github_activity",
  "polymarket_odds",
  "scrapecreators_tiktok",
  "scrapecreators_instagram",
  "scrapecreators_threads",
  "scrapecreators_pinterest",
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

/**
 * The triage loadout: the base toolset intersected with the read-only allow
 * predicate, so the mailbox persona can never advertise a tool Myra does not
 * otherwise carry.
 */
export const MAILBOX_PERSONA_TOOLS: string[] = PERSONAL_AGENT_BASE_TOOLS.filter(
  isMailboxReadOnlyTool,
);

const PREPARE_ONLY_RULES = `You are prepare-only. Do not send mail, message anyone, create or change any record, start a workflow, or take any other irreversible action. If the right next step is one of those, name it in your plan and leave it for the person to approve — never do it yourself in this pass.`;

const EXECUTE_WITH_GATES_RULES = `You may carry the next step out yourself when your tools allow it. Every externally visible or irreversible action is gated behind the person's approval rail, so request it when it is the right next step — it will be reviewed before anything happens. Still lead with the classification and plan, and still prepare a draft whenever a reply is warranted.`;

export function buildMailboxTriagePrompt(
  name: string,
  autonomy: AgentAutonomy = "prepare_only",
): string {
  const actionRules =
    autonomy === "execute_with_gates"
      ? EXECUTE_WITH_GATES_RULES
      : PREPARE_ONLY_RULES;
  const sections: PromptSection[] = [
    {
      tag: "role",
      content: `You are ${name}, triaging a single inbound message that has just arrived for the person you work for. Your job is to understand it, decide what it needs, and prepare the response — not to send anything. You hold the company's context: who the sender is, the history with them, and what work is in flight. Use it to judge the message accurately.`,
    },
    CORBITS_VOCABULARY_SECTION,
    {
      tag: "task",
      content: `Do three things and stop. (1) Classify the message: what it is, who it is from, and how it relates to existing people, deals, or work. (2) Assess priority and what it needs — a reply, an internal action, a hand-off, or nothing. (3) Prepare a draft response the person can review and send themselves.

${actionRules}`,
    },
    {
      tag: "knowledge",
      content: `Ground the triage in what the company already knows before reaching outside. When the sender or subject names a person, company, or deal, look up the relationship, recent calls, and open work first, and lead with that internal picture. Your tools here are read-only by design: gather context, do not change it. Web search is supplemental — for external facts you cannot find internally.`,
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

  return buildSystemPrompt(sections, { xml: true });
}

export const mailboxPersona: MyraPersona = {
  key: "mailbox",
  description:
    "Myra's inbound-mail triage persona: classify, plan, and prepare a draft response for one external message, read-only and prepare-only.",
  systemPrompt: buildMailboxTriagePrompt(PERSONAL_AGENT_NAME),
  toolNames: MAILBOX_PERSONA_TOOLS,
};

export type MailboxLoadout = {
  systemPrompt: string;
  toolNames: string[];
};

/**
 * The prompt + tool loadout a triage session mounts for a member's autonomy
 * setting. `prepare_only` is the persona verbatim (read-only allow-list);
 * `execute_with_gates` mounts the full base toolset with the gated-action
 * prompt — writes still flow through the approval rail, never around it.
 */
export function resolveMailboxLoadout(autonomy: AgentAutonomy): MailboxLoadout {
  if (autonomy === "execute_with_gates") {
    return {
      systemPrompt: buildMailboxTriagePrompt(PERSONAL_AGENT_NAME, autonomy),
      toolNames: PERSONAL_AGENT_BASE_TOOLS,
    };
  }
  return {
    systemPrompt: mailboxPersona.systemPrompt,
    toolNames: mailboxPersona.toolNames,
  };
}
