import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { MailboxRef } from "@workbench/shared";
import { memberAgentInstance } from "../db/schema";
import type { HubDb } from "../db";
import { isMemberSelfServiceCapabilityActive } from "../lib/capability-grants";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { writeMailboxMessage } from "../lib/mailbox-write";
import type {
  CallAction,
  CallAnalysis,
  CallClassification,
  GranolaCall,
} from "./granola-call-pipeline";

const log = getLogger(["services", "granola-call-fanout"]);

/** The Granola provider key gating a member's opt-in (their per-user OAuth
 * capability). Only members with Granola enabled receive call mail. */
const GRANOLA_PROVIDER = "granola";

const FANOUT_SENDER_LOCAL = "granola";

export interface FanOutInput {
  tenantId: string;
  note: GranolaCall;
  classification: CallClassification;
  analysis: CallAnalysis;
  artifactId: string;
}

export interface FanOutResult {
  delivered: number;
  /** Participants/mentions that resolved to no member (skipped + logged). */
  unmatched: string[];
}

export interface GranolaCallFanout {
  fanOut(input: FanOutInput): Promise<FanOutResult>;
}

export interface GranolaCallFanoutDeps {
  db: HubDb;
  grantStore: GrantStore;
  /** The tenant the capability grant + member enumeration are scoped to. */
  rootTenantId: string;
  /** The domain a member's `usr_<refId>@<domain>` inbox address is built on. */
  rootTenantDomain: string;
  mailboxEventBus?: MailboxEventBus;
}

interface Member {
  principalId: string;
  refId: string;
  name: string | null;
  email: string | null;
}

/** Root-tenant members that run Myra (the delivery population). */
async function listMyraMembers(
  db: HubDb,
  rootTenantId: string,
): Promise<Member[]> {
  const rows = await db
    .select({
      principalId: memberAgentInstance.memberPrincipalId,
      refId: intxSchema.principal.refId,
      name: intxSchema.user.name,
      email: intxSchema.user.email,
    })
    .from(memberAgentInstance)
    .innerJoin(
      intxSchema.principal,
      eq(intxSchema.principal.id, memberAgentInstance.memberPrincipalId),
    )
    .innerJoin(
      intxSchema.user,
      eq(intxSchema.user.id, intxSchema.principal.refId),
    )
    .where(
      and(
        eq(memberAgentInstance.tenantId, rootTenantId),
        eq(memberAgentInstance.templateKey, "myra"),
      ),
    );
  return rows.map((row) => ({
    principalId: row.principalId,
    refId: row.refId,
    name: row.name ?? null,
    email: row.email ?? null,
  }));
}

function looksLikeEmail(value: string): boolean {
  return value.includes("@");
}

/**
 * Resolve a set of participant strings to members. Match by email first
 * (exact, case-insensitive); fall back to name ONLY when it maps to exactly
 * one member (an ambiguous name is never guessed). Returns the matched members
 * and the participant strings that matched nothing.
 */
export function matchParticipantsToMembers(
  participants: readonly string[],
  members: readonly Member[],
): { matched: Member[]; unmatched: string[] } {
  const byEmail = new Map<string, Member>();
  const byName = new Map<string, Member[]>();
  for (const member of members) {
    if (member.email) byEmail.set(member.email.toLowerCase(), member);
    if (member.name) {
      const key = member.name.toLowerCase();
      const list = byName.get(key) ?? [];
      list.push(member);
      byName.set(key, list);
    }
  }

  const matched = new Map<string, Member>();
  const unmatched: string[] = [];
  for (const raw of participants) {
    const participant = raw.trim();
    if (participant === "") continue;
    const key = participant.toLowerCase();

    if (looksLikeEmail(participant)) {
      const member = byEmail.get(key);
      if (member) {
        matched.set(member.principalId, member);
        continue;
      }
      unmatched.push(participant);
      continue;
    }

    const nameMatches = byName.get(key);
    if (nameMatches && nameMatches.length === 1) {
      const member = nameMatches[0];
      if (member) {
        matched.set(member.principalId, member);
        continue;
      }
    }
    unmatched.push(participant);
  }

  return { matched: [...matched.values()], unmatched };
}

/** An action is this member's if its assignee matches their email or name. */
function actionsForMember(
  actions: readonly CallAction[],
  member: Member,
): CallAction[] {
  const email = member.email?.toLowerCase();
  const name = member.name?.toLowerCase();
  return actions.filter((action) => {
    if (!action.assignee) return false;
    const assignee = action.assignee.toLowerCase();
    return (
      (email !== undefined && assignee === email) ||
      (name !== undefined && assignee === name)
    );
  });
}

function renderActionLines(actions: readonly CallAction[]): string {
  if (actions.length === 0) return "- (none assigned to you)";
  return actions.map((a) => `- ${a.description}`).join("\n");
}

function buildBody(
  input: FanOutInput,
  member: Member,
  artifactLabel: string,
): string {
  const title = input.note.title ?? "(untitled)";
  const myActionItems = [
    ...actionsForMember(input.analysis.tasks, member),
    ...actionsForMember(input.analysis.actionItems, member),
  ];
  return [
    `You were on a call ("${title}") that Workbench just summarized.`,
    "",
    input.analysis.summary,
    "",
    `Call: ${title} (${input.classification})`,
    `Artifact: ${artifactLabel}`,
    "",
    "Your action items:",
    renderActionLines(myActionItems),
  ].join("\n");
}

/** Idempotency key for one (call, recipient) mail — one mail per member per
 * call, deduped by `writeMailboxMessage`'s messageKey upsert. */
export function fanOutMessageKey(noteId: string, principalId: string): string {
  return `granola-call:${noteId}:${principalId}`;
}

/**
 * Fan a processed call out to the members who were on it (CL-3583). Matches
 * call participants + mentioned people to root-tenant Myra members, keeps only
 * those with Granola enabled, and mails each one the summary, an artifact
 * reference, and their own tasks/action items — one deduped mail per
 * (call, recipient). Unmatched participants and Granola-disabled members are
 * skipped and logged, never guessed.
 */
export function createGranolaCallFanout(
  deps: GranolaCallFanoutDeps,
): GranolaCallFanout {
  async function fanOut(input: FanOutInput): Promise<FanOutResult> {
    const members = await listMyraMembers(deps.db, deps.rootTenantId);
    const participants = [
      ...(input.note.participants ?? []),
      ...input.analysis.peopleMentioned,
    ];
    const { matched, unmatched } = matchParticipantsToMembers(
      participants,
      members,
    );

    if (unmatched.length > 0) {
      log.info("granola fan-out: unmatched participants for {noteId}", {
        noteId: input.note.id,
        unmatched,
      });
    }

    const title = input.note.title ?? "Call";
    const artifactLabel = `View call artifact: ${title}`;
    const fromAddress = `${FANOUT_SENDER_LOCAL}@${deps.rootTenantDomain}`;
    const refs: MailboxRef[] = [
      { kind: "artifact", ref: input.artifactId, label: artifactLabel },
    ];

    let delivered = 0;
    for (const member of matched) {
      const enabled = await isMemberSelfServiceCapabilityActive(
        deps.grantStore,
        deps.db,
        deps.rootTenantId,
        member.principalId,
        GRANOLA_PROVIDER,
      );
      if (!enabled) {
        log.info("granola fan-out: recipient not Granola-enabled; skipping", {
          noteId: input.note.id,
          principalId: member.principalId,
        });
        continue;
      }

      const inboxAddress = deriveUserMailAddress({
        userRefId: member.refId,
        domain: deps.rootTenantDomain,
      });
      const written = await writeMailboxMessage(
        deps.db,
        {
          tenantId: deps.rootTenantId,
          principalId: member.principalId,
          address: inboxAddress,
          fromAddress,
          subject: `Call summary: ${title}`,
          body: buildBody(input, member, artifactLabel),
          messageKey: fanOutMessageKey(input.note.id, member.principalId),
          refs,
        },
        deps.mailboxEventBus,
      );
      if (written) delivered += 1;
    }

    return { delivered, unmatched };
  }

  return { fanOut };
}
