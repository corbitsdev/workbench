import { getLogger } from "@intx/log";
import { fetchLinearGraphQL } from "@workbench/tools-linear";
import {
  findOAuthProviderConfig,
  resolveEnabledInboxSources,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { buildMailFrame, writeMailboxMessage } from "../lib/mailbox-write";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { memberHoldsCapabilityGrant } from "../lib/capability-grants";
import { readMemberPreferences } from "../lib/member-preferences";
import {
  resolveMemberOrTenantToolCredential,
  type MemberToolCredential,
} from "../lib/member-tool-credential";
import type { MailboxTriage } from "./mailbox-triage";
import type { UserMailboxRowEvent } from "../lib/principal-mailbox";

const log = getLogger(["services", "inbox-intake"]);

const DEFAULT_TICK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PER_SOURCE_LIMIT = 25;
const FETCH_TIMEOUT_MS = 20_000;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LINEAR_INTAKE_QUERY = `query InboxIntakeIssues($first: Int!, $filter: IssueFilter) {
  issues(first: $first, filter: $filter, orderBy: createdAt) {
    nodes { id identifier title state { name } assignee { name } team { name } url createdAt }
  }
}`;

const fetchLinearIssues: InboxSourceFetcher = async (
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

/**
 * The wired live-intake sources, keyed by inbox source key. A source present
 * here has a hub-callable fetcher; a source that is toggleable but not yet
 * wired for live intake is simply absent — the tick skips it legibly (logged
 * once) rather than stubbing an empty fetch. Attio + Granola live intake are
 * additive: register their fetcher here when built.
 */
export const INBOX_SOURCE_FETCHERS: Readonly<
  Record<string, InboxSourceFetcher>
> = {
  linear: fetchLinearIssues,
};

export interface InboxIntakeDeps {
  db: HubDb;
  /** Enumerate the members to poll (their inbox address + tenant domain). */
  listMembers: () => Promise<InboxIntakeMember[]>;
  mailboxEventBus?: MailboxEventBus;
  /** Triage handoff: intake rows are enqueued so they flow through the same
   * pipeline as inbound mail. Triage self-gates on its own feature grant, so
   * enqueue is unconditional here. */
  mailboxTriage?: Pick<MailboxTriage, "enqueue">;
  /** Per-tenant enablement (env override OR owner grant), re-read each tick. */
  isTenantEnabled: (tenantId: string) => Promise<boolean>;
  fetchers?: Readonly<Record<string, InboxSourceFetcher>>;
  now?: () => number;
  tickIntervalMs?: number;
  lookbackMs?: number;
  perSourceLimit?: number;
}

export interface InboxIntake {
  start(): void;
  stop(): void;
  /** Run one full pass; exposed for tests and driven by the interval. */
  tick(): Promise<void>;
}

/**
 * Live per-item inbox intake (CL-3511). Each tick, for every member with
 * enabled `inboxSource:*` prefs, fetches new items from each wired source using
 * the CL-3510 credential rail (member connection → tenant key), writes one
 * mailbox row per new item (deduped by `messageKey`), publishes the SSE
 * delivery signal, and hands the row to triage. A source with no usable
 * credential — or an OAuth provider the member has not enabled the capability
 * for — is skipped legibly, never stubbed.
 */
export function createInboxIntake(deps: InboxIntakeDeps): InboxIntake {
  const now = deps.now ?? Date.now;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const perSourceLimit = deps.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT;
  const fetchers = deps.fetchers ?? INBOX_SOURCE_FETCHERS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function intakeSourceForMember(
    member: InboxIntakeMember,
    sourceKey: string,
    cutoff: Date,
  ): Promise<void> {
    const fetcher = fetchers[sourceKey];
    if (!fetcher) return; // toggleable but not wired for live intake yet

    // OAuth-connectable providers require the member's own capability opt-in
    // (the CL-3510 per-principal grant); non-OAuth sources are governed by the
    // inbox-source toggle alone.
    if (findOAuthProviderConfig(sourceKey)) {
      const granted = await memberHoldsCapabilityGrant(
        deps.db,
        member.tenantId,
        member.memberPrincipalId,
        sourceKey,
      );
      if (!granted) return;
    }

    const cred = await resolveMemberOrTenantToolCredential(
      deps.db,
      member.tenantId,
      member.memberPrincipalId,
      sourceKey,
    );
    if (!cred) {
      log.info("inbox intake: no usable credential; skipping source", {
        tenantId: member.tenantId,
        memberPrincipalId: member.memberPrincipalId,
        source: sourceKey,
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let items: IntakeItem[];
    try {
      items = await fetcher(cred, cutoff, perSourceLimit, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    const fromAddress = `${sourceKey}@${member.tenantDomain}`;
    for (const item of items) {
      const written = await writeMailboxMessage(
        deps.db,
        {
          tenantId: member.tenantId,
          principalId: member.memberPrincipalId,
          address: member.inboxAddress,
          fromAddress,
          subject: item.subject,
          body: item.body,
          messageKey: `inbox:${sourceKey}:${item.externalId}`,
        },
        deps.mailboxEventBus,
      );
      if (!written) continue; // already delivered (dedupe)
      if (deps.mailboxTriage) {
        const event: UserMailboxRowEvent = {
          rowId: written.id,
          tenantId: member.tenantId,
          memberPrincipalId: member.memberPrincipalId,
          recipientAddress: member.inboxAddress,
          senderAddress: fromAddress,
          subject: item.subject,
          fromAddress,
          raw: buildMailFrame({
            from: fromAddress,
            to: member.inboxAddress,
            subject: item.subject,
            body: item.body,
          }),
        };
        deps.mailboxTriage.enqueue(event);
      }
    }
  }

  async function tick(): Promise<void> {
    let members: InboxIntakeMember[];
    try {
      members = await deps.listMembers();
    } catch (err) {
      log.error("inbox intake: enumerate members failed", {
        error: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }
    const cutoff = new Date(now() - lookbackMs);
    for (const member of members) {
      let enabled: boolean;
      try {
        enabled = await deps.isTenantEnabled(member.tenantId);
      } catch {
        enabled = false;
      }
      if (!enabled) continue;

      const prefs = await readMemberPreferences(
        deps.db,
        member.tenantId,
        member.memberPrincipalId,
      );
      const sources = resolveEnabledInboxSources(prefs);
      for (const sourceKey of sources) {
        try {
          await intakeSourceForMember(member, sourceKey, cutoff);
        } catch (err) {
          log.error("inbox intake: source failed", {
            tenantId: member.tenantId,
            memberPrincipalId: member.memberPrincipalId,
            source: sourceKey,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        if (running) return;
        running = true;
        void tick()
          .catch((err) =>
            log.error("inbox intake: tick failed", {
              error: err instanceof Error ? err : new Error(String(err)),
            }),
          )
          .finally(() => {
            running = false;
          });
      }, tickIntervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
