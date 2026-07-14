import { getLogger } from "@intx/log";
import type { HubDb } from "../db";
import type { MemberToolCredential } from "../lib/member-tool-credential";
import { attioTaskSyncInboxSource } from "./inbox-sources/attio-task-sync";
import { fetchLinearInboxItems } from "./inbox-sources/linear";

/** A member the intake tick delivers to: their principal, external-account
 * lookup key (`usr_<refId>` inbox address is derived from `userRefId`), and
 * tenant domain (the intake sender + inbox address share it). */
export interface InboxIntakeMember {
  tenantId: string;
  memberPrincipalId: string;
  /** The member's inbox address the rows are filed under (their `usr_` addr). */
  inboxAddress: string;
  tenantDomain: string;
  /** The member's account email, used to scope a source that has no member
   * OAuth identity (a tenant-shared key) to this member — e.g. Linear's
   * `assignee: { email: { eq } }` filter. Null when the account carries no
   * email; such members are skipped for email-scoped tenant-key fetches
   * rather than guessed at (CL-3580). */
  email: string | null;
}

/** One new external item an intake source surfaces. `externalId` is the
 * source-stable id used to dedupe (`inbox:<source>:<externalId>` messageKey);
 * `url` is the clickable link emitted in the body (structured refs land later
 * via CL-3507). */
export interface IntakeItem {
  externalId: string;
  subject: string;
  body: string;
  url: string;
  /** When known, the item's own source timestamp (issue `updatedAt`,
   * comment/notification `createdAt`, etc.) — lets a full/truncated page
   * advance its cursor to the newest PROCESSED item instead of pinning at the
   * unchanged `since` floor. Without it, sustained overflow (>= perSourceLimit
   * new items every tick) would re-issue the identical query forever and
   * starve everything past page 1 of the window. A fetcher that cannot supply
   * this on every item falls back to the pin-at-`since` behavior. */
  occurredAt?: Date;
}

/**
 * Fetches items created/updated since `cutoff` for one source, using the
 * member-or-tenant resolved credential. Throws on a real API failure (the tick
 * logs and moves on); returns [] when there is simply nothing new.
 */
export type InboxSourceFetcher = (
  cred: MemberToolCredential,
  cutoff: Date,
  limit: number,
  signal: AbortSignal,
  /** The member's account email, when known — lets a fetcher scope a
   * tenant-shared credential to this member (the source has no per-member
   * OAuth identity to scope to). Undefined for workspace-scope fetches. */
  memberEmail?: string | null,
  /** The member's raw preference bag (CL-3580), passed through so a
   * fetcher can read its own per-source options (e.g.
   * `inboxSource:linear:scope`) without the registry framework knowing about
   * any particular source's preference keys. Undefined for workspace-scope
   * fetches. */
  memberPreferences?: Readonly<Record<string, unknown>>,
) => Promise<IntakeItem[]>;

/** Whether a source runs per enabled MEMBER (`member`, gated by the member's
 * `inboxSource:*` preference + OAuth capability opt-in + member-or-tenant
 * credential) or once per TENANT per tick (`workspace`, gated by an
 * owner-level enablement, default OFF — for tenant-wide pollers that upsert
 * tasks or trigger a pipeline rather than write one member's mailbox). */
export type InboxSourceScope = "member" | "workspace";

/** Shared context both scopes receive: the resolved credential, the tick's
 * lookback `cutoff`, an optional per-source `lastPollAt` cursor, the fetch
 * limit, an abort `signal` bounding the handler, and a scoped logger. */
interface InboxSourceContextBase {
  db: HubDb;
  tenantId: string;
  credential: MemberToolCredential;
  /** now - lookbackMs: the default 24h lookback a source may use or ignore. */
  cutoff: Date;
  /** When this scope was last polled, if the host tracks a cursor. */
  lastPollAt?: Date;
  perSourceLimit: number;
  signal: AbortSignal;
  log: ReturnType<typeof getLogger>;
  /** A host-injected fetcher override for this source key (tests, or future
   * per-source fetcher wiring); undefined when the source uses its own. */
  fetcherOverride?: InboxSourceFetcher;
}

/** Member-scope context: carries the member and a `deliverItems` helper that
 * writes one deduped mailbox row per item, publishes the SSE delivery signal,
 * and hands each new row to triage — the existing per-item intake behavior,
 * exposed as a primitive so a member source is just "fetch → deliverItems". */
export interface MemberInboxSourceContext extends InboxSourceContextBase {
  scope: "member";
  member: InboxIntakeMember;
  /** The member's raw preference bag (CL-3580), for a fetcher to read its own
   * per-source options (e.g. `inboxSource:linear:scope`). */
  memberPreferences: Readonly<Record<string, unknown>>;
  /** Write + SSE-publish + triage-enqueue each item (deduped); returns the
   * count of newly delivered rows. */
  deliverItems: (items: IntakeItem[]) => Promise<number>;
}

/** Workspace-scope context: no member and no mailbox delivery helper — a
 * tenant-wide handler owns its own side effect (task upsert, pipeline
 * trigger). */
export interface WorkspaceInboxSourceContext extends InboxSourceContextBase {
  scope: "workspace";
}

export type InboxSourceContext =
  | MemberInboxSourceContext
  | WorkspaceInboxSourceContext;

/**
 * A handler's report of where its next poll should resume from. `undefined`
 * (or a bare `void` return) tells the core to advance the cursor to the
 * START of the tick that just ran (`tickStart`, not completion time — so
 * items created while the handler was in flight are never skipped). A
 * handler that may have truncated its window (a full, limit-capped page)
 * MUST instead return `{ nextCursor: <progress marker> }` so the core does
 * NOT advance past unseen items in that page. The progress marker is the
 * newest item's own timestamp actually processed this tick when the source
 * can supply one (max `occurredAt` / `created_at`) — that advances the
 * window monotonically so SUSTAINED overflow (>= perSourceLimit new items
 * every tick) drains the backlog instead of re-issuing the identical query
 * forever and starving everything past page 1. A source with no per-item
 * timestamp falls back to pinning the unchanged `since` and relies on
 * dedupe (externalId / sourceRef) to absorb the re-fetched overlap — that
 * fallback livelocks under sustained overflow, so a fetcher should supply a
 * timestamp whenever it has one.
 */
export interface InboxSourceTickResult {
  nextCursor?: Date;
}

/**
 * One registered inbox source. Adding a source is purely additive: export one
 * entry object from a source file and add one line to `INBOX_SOURCE_REGISTRY`
 * — no changes to the intake core. The core resolves the credential, enforces
 * the scope's gate (member prefs + capability for `member`, owner enablement
 * for `workspace`), bounds the call with a timeout, and invokes `handle`.
 */
export interface InboxSourceRegistryEntry {
  /** For `member` scope this MUST match an `INBOX_SOURCE_CATALOG` key (the
   * member's `inboxSource:<key>` preference gates it). For `workspace` scope
   * it is any stable key the owner-enablement gate is keyed on. */
  key: string;
  scope: InboxSourceScope;
  handle: (
    ctx: InboxSourceContext,
  ) => Promise<InboxSourceTickResult | undefined>;
}

/**
 * Build a member-scope source from a plain fetcher: the handler fetches with
 * the effective fetcher (a host override, else the source's own) and delivers
 * every item. This is the shape the Linear source has always used — kept
 * working verbatim on top of the registry.
 *
 * Cursor contract: when the fetch returns a full, limit-capped page
 * (`items.length >= ctx.perSourceLimit`), the page may have truncated the
 * window — there could be more items still unseen inside it. When at least
 * one returned item carries `occurredAt` (CL-3577 review fix), the handler
 * advances `nextCursor` to the MAX `occurredAt` of the items actually
 * processed this tick — that guarantees forward progress through a
 * sustained backlog (>= perSourceLimit new items every tick) instead of
 * re-issuing the identical query forever. A fetcher that supplies no
 * `occurredAt` on any item falls back to `{ nextCursor: since }` (the
 * unchanged lower bound); the core leaves the cursor alone and the next tick
 * re-fetches the same window, with dedupe absorbing the overlap — but that
 * fallback livelocks under sustained overflow, so a fetcher wanting
 * overflow-progress must populate `occurredAt`. A partial page (fewer than
 * the limit) is authoritative for the window, so the handler reports
 * `undefined` and the core advances to the tick's start time.
 */
/** The newest `occurredAt` among `items`, or `undefined` when none carry one
 * — the shared "advance-to-max-processed" rule used by every source that can
 * supply a per-item timestamp on a full/truncated page. */
export function maxOccurredAt(items: readonly IntakeItem[]): Date | undefined {
  let max: Date | undefined;
  for (const item of items) {
    if (item.occurredAt === undefined) continue;
    if (max === undefined || item.occurredAt > max) max = item.occurredAt;
  }
  return max;
}

export function defineFetchInboxSource(
  key: string,
  fetcher: InboxSourceFetcher,
): InboxSourceRegistryEntry {
  return {
    key,
    scope: "member",
    handle: async (ctx): Promise<InboxSourceTickResult | undefined> => {
      if (ctx.scope !== "member") return;
      const effective = ctx.fetcherOverride ?? fetcher;
      // Same cursor narrowing as the non-fetch-shaped sources (Attio/Granola):
      // steady-state polls fetch since the last successful tick; `cutoff` is
      // the floor (and carries the one-time Linear backfill widening, which
      // only applies when no cursor exists yet). Missed-past-the-limit items
      // are re-surfaced by the externalId dedupe when they next update.
      const since =
        ctx.lastPollAt && ctx.lastPollAt > ctx.cutoff
          ? ctx.lastPollAt
          : ctx.cutoff;
      const items = await effective(
        ctx.credential,
        since,
        ctx.perSourceLimit,
        ctx.signal,
        ctx.member.email,
        ctx.memberPreferences,
      );
      await ctx.deliverItems(items);
      if (items.length >= ctx.perSourceLimit) {
        const progress = maxOccurredAt(items);
        return { nextCursor: progress ?? since };
      }
      return undefined;
    },
  };
}

/** The Linear inbox source — member-scoped, fetch-shaped. CL-3580 upgraded it
 * from a workspace-wide "issues created in last 24h" poll to a per-member
 * viewer-scoped sync (inbox notifications, assigned issues, updates on
 * assigned issues); see `inbox-sources/linear.ts`. */
export const linearInboxSource = defineFetchInboxSource(
  "linear",
  fetchLinearInboxItems,
);

/**
 * The registered live-intake sources. A source present here is wired; a source
 * that is toggleable (has an `INBOX_SOURCE_CATALOG` entry) but absent here is
 * simply not polled — the tick skips it legibly rather than stubbing an empty
 * fetch. Attio/Linear task-sync and the Granola workspace poller register their
 * entries here when built (each as one exported object + one line).
 */
export const INBOX_SOURCE_REGISTRY: readonly InboxSourceRegistryEntry[] = [
  linearInboxSource,
  attioTaskSyncInboxSource,
];
