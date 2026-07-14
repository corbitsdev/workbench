import { getLogger } from "@intx/log";
import { fetchLinearGraphQL } from "@workbench/tools-linear";
import type { HubDb } from "../db";
import type { MemberToolCredential } from "../lib/member-tool-credential";

/** A member the intake tick delivers to: their principal, external-account
 * lookup key (`usr_<refId>` inbox address is derived from `userRefId`), and
 * tenant domain (the intake sender + inbox address share it). */
export interface InboxIntakeMember {
  tenantId: string;
  memberPrincipalId: string;
  /** The member's inbox address the rows are filed under (their `usr_` addr). */
  inboxAddress: string;
  tenantDomain: string;
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
  handle: (ctx: InboxSourceContext) => Promise<void>;
}

/**
 * Build a member-scope source from a plain fetcher: the handler fetches with
 * the effective fetcher (a host override, else the source's own) and delivers
 * every item. This is the shape the Linear source has always used — kept
 * working verbatim on top of the registry.
 */
export function defineFetchInboxSource(
  key: string,
  fetcher: InboxSourceFetcher,
): InboxSourceRegistryEntry {
  return {
    key,
    scope: "member",
    handle: async (ctx) => {
      if (ctx.scope !== "member") return;
      const effective = ctx.fetcherOverride ?? fetcher;
      const items = await effective(
        ctx.credential,
        ctx.cutoff,
        ctx.perSourceLimit,
        ctx.signal,
      );
      await ctx.deliverItems(items);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LINEAR_INTAKE_QUERY = `query InboxIntakeIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: createdAt) {
    nodes { id identifier title state { name } assignee { name } team { name } url createdAt }
  }
}`;

export const fetchLinearIssues: InboxSourceFetcher = async (
  cred,
  cutoff,
  limit,
  signal,
) => {
  const data = await fetchLinearGraphQL(
    { apiKey: cred.apiKey, ...(cred.baseURL ? { baseUrl: cred.baseURL } : {}) },
    LINEAR_INTAKE_QUERY,
    { first: limit, filter: { createdAt: { gt: cutoff.toISOString() } } },
    signal,
  );
  const issues = data.issues;
  const nodes =
    isRecord(issues) && Array.isArray(issues.nodes) ? issues.nodes : [];
  const items: IntakeItem[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const id = typeof node.id === "string" ? node.id : null;
    const url = typeof node.url === "string" ? node.url : "";
    if (id === null) continue;
    const identifier =
      typeof node.identifier === "string" ? node.identifier : id;
    const title = typeof node.title === "string" ? node.title : "(untitled)";
    const state =
      isRecord(node.state) && typeof node.state.name === "string"
        ? node.state.name
        : "unknown";
    const assignee =
      isRecord(node.assignee) && typeof node.assignee.name === "string"
        ? node.assignee.name
        : "unassigned";
    items.push({
      externalId: id,
      subject: `[${identifier}] ${title}`,
      body: [
        `New Linear issue ${identifier}: ${title}`,
        "",
        `State: ${state}`,
        `Assignee: ${assignee}`,
        url ? `Link: ${url}` : "",
      ]
        .filter((line) => line !== "")
        .join("\n"),
      url,
    });
  }
  return items;
};

/** The Linear inbox source — member-scoped, fetch-shaped. Its behavior is
 * unchanged by CL-3577 (only the framework around it moved). */
export const linearInboxSource = defineFetchInboxSource(
  "linear",
  fetchLinearIssues,
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
];
