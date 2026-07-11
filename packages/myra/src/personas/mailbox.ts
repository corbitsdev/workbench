import { buildSystemPrompt, type PromptSection } from "@workbench/prompts";
import { CORBITS_VOCABULARY_SECTION } from "@workbench/agents/corbits-vocabulary";
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

/**
 * Bare tool names excluded from the triage loadout because they mutate state.
 * The subset is derived by filtering the base toolset (below) so the mailbox
 * loadout can never advertise a tool Myra does not otherwise carry, and adding
 * a write tool to the base list keeps it out of triage automatically.
 */
const MAILBOX_EXCLUDED_TOOLS = [
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

function mutatesState(toolName: string): boolean {
  return MAILBOX_EXCLUDED_TOOLS.some(
    (bare) => toolName === bare || toolName.endsWith(`:${bare}`),
  );
}

export const MAILBOX_PERSONA_TOOLS: string[] = PERSONAL_AGENT_BASE_TOOLS.filter(
  (name) => !mutatesState(name),
);

export function buildMailboxTriagePrompt(name: string): string {
  const sections: PromptSection[] = [
    {
      tag: "role",
      content: `You are ${name}, triaging a single inbound message that has just arrived for the person you work for. Your job is to understand it, decide what it needs, and prepare the response — not to send anything. You hold the company's context: who the sender is, the history with them, and what work is in flight. Use it to judge the message accurately.`,
    },
    CORBITS_VOCABULARY_SECTION,
    {
      tag: "task",
      content: `Do three things and stop. (1) Classify the message: what it is, who it is from, and how it relates to existing people, deals, or work. (2) Assess priority and what it needs — a reply, an internal action, a hand-off, or nothing. (3) Prepare a draft response the person can review and send themselves.

You are prepare-only. Do not send mail, message anyone, create or change any record, start a workflow, or take any other irreversible action. If the right next step is one of those, name it in your plan and leave it for the person to approve — never do it yourself in this pass.`,
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
