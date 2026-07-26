/**
 * Pure helpers for the daily LinkedIn consumer (CL-4033).
 * No I/O — hub tools and the workflow pack call these for stable keys.
 */

import { type } from "arktype";
import {
  mailboxAddressForMember,
  SelectedPersonListSchema,
  type SelectedPerson,
} from "@workbench/shared";

export { mailboxAddressForMember };

/** Artifact kind produced by scrape-for-stories (CL-4430). */
export const STORY_BUCKET_ARTIFACT_KIND = "story-bucket" as const;

/** Per-principal LinkedIn draft artifact kind written by daily-linkedin. */
export const LINKEDIN_DAILY_DRAFT_KIND = "linkedin-daily-draft" as const;

/** Local-part for the workflow's outbound mailbox address. */
export const DAILY_LINKEDIN_FROM_LOCAL = "daily-linkedin" as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireNonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function requireUtcDay(dayUtc: string): string {
  const day = requireNonEmpty(dayUtc, "dayUtc");
  if (!DAY_RE.test(day)) {
    throw new Error(`dayUtc must be YYYY-MM-DD, got: ${dayUtc}`);
  }
  return day;
}

/** UTC calendar day as YYYY-MM-DD. */
export function utcDayString(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Tenant-scoped artifact sourceRef for one recipient's draft on a UTC day.
 * Keyed by the recipient's auth `refId` — the only stable identifier a stored
 * schedule selection carries (CL-4429); a workflow pack never holds a tenant
 * principal id. Re-runs the same day update the same artifact row.
 */
export function dailyDraftSourceRef(refId: string, dayUtc: string): string {
  const id = requireNonEmpty(refId, "refId");
  const day = requireUtcDay(dayUtc);
  return `linkedin-daily:${id}:${day}`;
}

/**
 * Mailbox messageKey for one recipient's draft delivery on a UTC day.
 * writeMailboxMessage treats a repeat key as a no-op (no re-mail spam).
 */
export function dailyMailMessageKey(refId: string, dayUtc: string): string {
  const id = requireNonEmpty(refId, "refId");
  const day = requireUtcDay(dayUtc);
  return `linkedin-daily-mail:${id}:${day}`;
}

/**
 * One recipient as stored in the schedule payload: the routing key (`refId`)
 * plus the name used for the draft's subject/title and voice framing.
 *
 * This is `SelectedPerson` from `@workbench/shared` — the SAME shape the
 * `select-multi` schedule control produces — aliased, never redeclared. A
 * second hand-written `{ refId, displayName }` here is the CL-4581 defect:
 * one copy drifts, the suite stays green, the feature dies quietly.
 */
export type DailyLinkedInRecipient = SelectedPerson;

export type DailyLinkedInDraftInput = DailyLinkedInRecipient & {
  body: string;
};

/**
 * Build a ready-to-send `inbox_deliver_batch` payload for Daily LinkedIn.
 * Callers (tests, format tools, docs) use this so keys never diverge from
 * the pure helpers above.
 */
export function buildDailyLinkedInBatch(args: {
  userAddress: string;
  dayUtc?: string;
  drafts: DailyLinkedInDraftInput[];
}): {
  fromLocalPart: string;
  userAddress: string;
  deliveries: {
    refId: string;
    subject: string;
    body: string;
    messageKey: string;
    artifact: {
      title: string;
      body: string;
      kind: string;
      sourceRef: string;
      jobLabel: string;
    };
  }[];
} {
  const userAddress = requireNonEmpty(args.userAddress, "userAddress");
  const dayUtc = requireUtcDay(args.dayUtc ?? utcDayString());
  if (!Array.isArray(args.drafts) || args.drafts.length === 0) {
    throw new Error("drafts must contain at least one entry");
  }

  return {
    fromLocalPart: DAILY_LINKEDIN_FROM_LOCAL,
    userAddress,
    deliveries: args.drafts.map((draft) => {
      const refId = requireNonEmpty(draft.refId, "refId");
      const displayName = requireNonEmpty(draft.displayName, "displayName");
      const body = requireNonEmpty(draft.body, "body");
      const subject = `LinkedIn draft — ${displayName} (${dayUtc})`;
      return {
        refId,
        subject,
        body,
        messageKey: dailyMailMessageKey(refId, dayUtc),
        artifact: {
          title: subject,
          body,
          kind: LINKEDIN_DAILY_DRAFT_KIND,
          sourceRef: dailyDraftSourceRef(refId, dayUtc),
          jobLabel: "daily-linkedin",
        },
      };
    }),
  };
}

export type DailyLinkedInMemberIdentity = {
  userAddress: string;
  userRefId: string;
  /** The firing member's display name, when known (absent for an agent
   * principal or on an identity-lookup miss). */
  userDisplayName?: string;
};

/**
 * Fire-time enrichment for daily-linkedin starts.
 *
 * The drafting agent's ONLY route to `inbox_deliver_batch`'s required
 * `userAddress` is the trigger payload — it is not a schedule field (a member
 * cannot type their own mailbox address into a schedule form, and no other step
 * resolves it), and no static analysis of an agent step can flag its absence
 * because the agent chooses its tool arguments at run time. Without this
 * enricher every scheduled fire reaches step 4 of the prompt with no address
 * and either fails the deliver call or invents one. Stamping identity here is
 * what makes the kind genuinely schedulable, exactly as heartbeat and
 * prospect-engine do.
 *
 * Pure over its inputs so the enrichment is unit-testable without a DB.
 */
export function enrichDailyLinkedInTriggerPayload(
  triggerPayload: Record<string, unknown>,
  memberIdentity: DailyLinkedInMemberIdentity,
): Record<string, unknown> {
  // Parse the stored selection at the boundary rather than trusting it.
  // Schedules are long-lived rows: one created against an older `select-multi`
  // (whose value was a bare `string[]` of `prn_` principal ids) would otherwise
  // flow straight into the drafting agent, which would hand those ids to
  // `inbox_deliver_batch` as `refId`s. They resolve to nobody, so every
  // recipient would be silently skipped and the run would report "success"
  // having delivered nothing. Failing here instead names the fix.
  const recipients = SelectedPersonListSchema(triggerPayload.recipients);
  if (recipients instanceof type.errors) {
    throw new Error(
      `daily-linkedin: this schedule's recipient list is not a list of { refId, displayName } people (${recipients.summary}). Re-pick the recipients on the schedule.`,
    );
  }
  if (recipients.length === 0) {
    throw new Error(
      "daily-linkedin: this schedule has no recipients. An empty selection means nobody — pick at least one person on the schedule.",
    );
  }

  const enriched: Record<string, unknown> = {
    ...triggerPayload,
    userAddress: requireNonEmpty(memberIdentity.userAddress, "userAddress"),
    userRefId: requireNonEmpty(memberIdentity.userRefId, "userRefId"),
  };
  const displayName = memberIdentity.userDisplayName;
  if (typeof displayName === "string" && displayName.trim().length > 0) {
    enriched.userDisplayName = displayName.trim();
  }
  return enriched;
}
