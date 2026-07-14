import type { GrantStore } from "@intx/authz";
import { getLogger } from "@intx/log";
import {
  findOAuthProviderConfig,
  LINEAR_BACKFILL_PREFERENCE_KEY,
  resolveEnabledInboxSources,
} from "@workbench/shared";
import type { HubDb } from "../db";
import { deliverInboxItems } from "../lib/inbox-delivery";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { isMemberSelfServiceCapabilityActive } from "../lib/capability-grants";
import {
  mergeMemberPreferences,
  readMemberPreferences,
} from "../lib/member-preferences";
import {
  resolveMemberOrTenantToolCredential,
  resolveTenantToolCredential,
} from "../lib/member-tool-credential";
import type { MailboxTriage } from "./mailbox-triage";
import {
  INBOX_SOURCE_REGISTRY,
  type InboxIntakeMember,
  type InboxSourceContext,
  type InboxSourceFetcher,
  type InboxSourceRegistryEntry,
  type IntakeItem,
  type MemberInboxSourceContext,
} from "./inbox-source-registry";

export type {
  InboxIntakeMember,
  InboxSourceContext,
  InboxSourceFetcher,
  InboxSourceRegistryEntry,
  IntakeItem,
} from "./inbox-source-registry";

const log = getLogger(["services", "inbox-intake"]);

const DEFAULT_TICK_INTERVAL_MS = 60_000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PER_SOURCE_LIMIT = 25;
const FETCH_TIMEOUT_MS = 20_000;

// Linear one-time backfill on first enable (CL-3577): widens the cutoff for
// exactly one poll — the first one after the member enables the source — per
// `inboxSource:linear:backfill` ("7d" | "30d"; "none"/unset applies no
// widening). `LINEAR_BACKFILL_APPLIED_PREFERENCE_KEY` is a stamped marker
// (mirrors `onboarding.welcomeSentAt`'s pattern) written once the first poll
// completes so every later tick — including a later disable/re-enable —
// falls back to the normal lookback/lastPollAt cutoff.
const LINEAR_SOURCE_KEY = "linear";
const LINEAR_BACKFILL_APPLIED_PREFERENCE_KEY =
  "inboxSource:linear:backfillAppliedAt";
const LINEAR_BACKFILL_WINDOW_MS: Readonly<Record<string, number>> = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

export interface InboxIntakeDeps {
  db: HubDb;
  /** Owner + per-principal capability gate (same store as me-connections). */
  grantStore: GrantStore;
  /** Enumerate the members to poll (their inbox address + tenant domain). */
  listMembers: () => Promise<InboxIntakeMember[]>;
  mailboxEventBus?: MailboxEventBus;
  /** Triage handoff: intake rows are enqueued so they flow through the same
   * pipeline as inbound mail. Triage self-gates on its own feature grant, so
   * enqueue is unconditional here. */
  mailboxTriage?: Pick<MailboxTriage, "enqueue">;
  /** Per-tenant enablement (env override OR owner grant), re-read each tick. */
  isTenantEnabled: (tenantId: string) => Promise<boolean>;
  /** Owner-level enablement for a workspace-scope source, keyed by tenant +
   * source key. Default OFF when omitted (workspace sources are opt-in). */
  isWorkspaceSourceEnabled?: (
    tenantId: string,
    sourceKey: string,
  ) => Promise<boolean>;
  /** Owner-level enablement for a member-scope source, keyed by tenant + source
   * key. The tenant ceiling above the member's `inboxSource:*` preference
   * (CL-3584): an owner-disabled source is skipped for EVERY member regardless
   * of their preference. Defaults to ALLOW when omitted so tests and legacy
   * callers gate on the member preference alone; production wires the owner
   * grant. */
  isMemberSourceEnabled?: (
    tenantId: string,
    sourceKey: string,
  ) => Promise<boolean>;
  /** The registered sources to poll; defaults to `INBOX_SOURCE_REGISTRY`. */
  registry?: readonly InboxSourceRegistryEntry[];
  /** Per-source-key fetcher override (surfaced to a fetch-shaped source's
   * handler as `ctx.fetcherOverride`) — used by tests and future per-source
   * fetcher wiring. */
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
 * Live per-source inbox intake (CL-3511, per-source framework CL-3577). Each
 * tick runs on a 60s cadence over a typed source registry with two scopes:
 *
 * - `member` sources fetch per enabled member (gated by the member's
 *   `inboxSource:*` preference + the OAuth capability opt-in + the CL-3510
 *   member-or-tenant credential rail) and typically deliver mailbox rows via
 *   the `deliverItems` context primitive (deduped, SSE-published, triaged).
 * - `workspace` sources run once per tenant per tick, gated by an owner-level
 *   enablement (default OFF) rather than member prefs, with a tenant-owned
 *   credential — for tenant-wide handlers that upsert tasks or trigger a
 *   pipeline instead of writing one member's mailbox.
 *
 * A source with no usable credential — or (member scope) an OAuth provider the
 * member has not enabled the capability for — is skipped legibly, never
 * stubbed.
 */
export function createInboxIntake(deps: InboxIntakeDeps): InboxIntake {
  const now = deps.now ?? Date.now;
  const tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const lookbackMs = deps.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  const perSourceLimit = deps.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT;
  const registry = deps.registry ?? INBOX_SOURCE_REGISTRY;
  const isWorkspaceSourceEnabled =
    deps.isWorkspaceSourceEnabled ?? (async () => false);
  const isMemberSourceEnabled =
    deps.isMemberSourceEnabled ?? (async () => true);
  const memberSourcesByKey = new Map(
    registry.filter((e) => e.scope === "member").map((e) => [e.key, e]),
  );
  const workspaceSources = registry.filter((e) => e.scope === "workspace");
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  /** Write + SSE-publish + triage-enqueue each item for a member (deduped by
   * `inbox:<source>:<externalId>` messageKey). Returns the newly delivered
   * count. This is the existing per-item intake behavior, exposed to a
   * member-scope handler as `ctx.deliverItems`. */
  async function deliverItemsForMember(
    member: InboxIntakeMember,
    sourceKey: string,
    items: IntakeItem[],
  ): Promise<number> {
    return deliverInboxItems(
      {
        db: deps.db,
        ...(deps.mailboxEventBus
          ? { mailboxEventBus: deps.mailboxEventBus }
          : {}),
        ...(deps.mailboxTriage ? { mailboxTriage: deps.mailboxTriage } : {}),
      },
      member,
      sourceKey,
      items,
    );
  }

  async function withTimeout(
    handle: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      await handle(controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function runMemberSource(
    member: InboxIntakeMember,
    entry: InboxSourceRegistryEntry,
    cutoff: Date,
    preferences: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    // OAuth-connectable providers require the member's own capability opt-in
    // (the CL-3510 per-principal grant); non-OAuth sources are governed by the
    // inbox-source toggle alone.
    if (findOAuthProviderConfig(entry.key)) {
      const active = await isMemberSelfServiceCapabilityActive(
        deps.grantStore,
        deps.db,
        member.tenantId,
        member.memberPrincipalId,
        entry.key,
      );
      if (!active) return;
    }

    const cred = await resolveMemberOrTenantToolCredential(
      deps.db,
      member.tenantId,
      member.memberPrincipalId,
      entry.key,
    );
    if (!cred) {
      log.info("inbox intake: no usable credential; skipping source", {
        tenantId: member.tenantId,
        memberPrincipalId: member.memberPrincipalId,
        source: entry.key,
      });
      return;
    }

    await withTimeout(async (signal) => {
      const ctx: MemberInboxSourceContext = {
        scope: "member",
        db: deps.db,
        tenantId: member.tenantId,
        member,
        memberPreferences: preferences,
        credential: cred,
        cutoff,
        perSourceLimit,
        signal,
        log,
        deliverItems: (items) =>
          deliverItemsForMember(member, entry.key, items),
        ...(deps.fetchers?.[entry.key] !== undefined
          ? { fetcherOverride: deps.fetchers[entry.key] }
          : {}),
      };
      await entry.handle(ctx);
    });
  }

  async function runWorkspaceSource(
    tenantId: string,
    entry: InboxSourceRegistryEntry,
    cutoff: Date,
  ): Promise<void> {
    const cred = await resolveTenantToolCredential(
      deps.db,
      tenantId,
      entry.key,
    );
    if (!cred) {
      log.info(
        "inbox intake: no tenant credential; skipping workspace source",
        {
          tenantId,
          source: entry.key,
        },
      );
      return;
    }

    await withTimeout(async (signal) => {
      const ctx: InboxSourceContext = {
        scope: "workspace",
        db: deps.db,
        tenantId,
        credential: cred,
        cutoff,
        perSourceLimit,
        signal,
        log,
        ...(deps.fetchers?.[entry.key] !== undefined
          ? { fetcherOverride: deps.fetchers[entry.key] }
          : {}),
      };
      await entry.handle(ctx);
    });
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

    // Workspace-scope sources: once per tenant per tick, gated by owner
    // enablement. The tenant set is derived from the members to poll.
    if (workspaceSources.length > 0) {
      const tenantIds = [...new Set(members.map((m) => m.tenantId))];
      for (const tenantId of tenantIds) {
        let enabled: boolean;
        try {
          enabled = await deps.isTenantEnabled(tenantId);
        } catch {
          enabled = false;
        }
        if (!enabled) continue;
        for (const entry of workspaceSources) {
          let sourceEnabled: boolean;
          try {
            sourceEnabled = await isWorkspaceSourceEnabled(tenantId, entry.key);
          } catch {
            sourceEnabled = false;
          }
          if (!sourceEnabled) continue;
          try {
            await runWorkspaceSource(tenantId, entry, cutoff);
          } catch (err) {
            log.error("inbox intake: workspace source failed", {
              tenantId,
              source: entry.key,
              error: err instanceof Error ? err : new Error(String(err)),
            });
          }
        }
      }
    }

    // Member-scope sources: per enabled member, gated by the member's
    // `inboxSource:*` preferences.
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
        const entry = memberSourcesByKey.get(sourceKey);
        if (!entry) continue; // toggleable but not wired for live intake yet
        // Owner ceiling (CL-3584): an owner-disabled source is skipped for
        // every member even when their preference enables it. A gate failure
        // is treated as disabled — never fails open.
        let ownerEnabled: boolean;
        try {
          ownerEnabled = await isMemberSourceEnabled(
            member.tenantId,
            sourceKey,
          );
        } catch {
          ownerEnabled = false;
        }
        if (!ownerEnabled) continue;

        // Linear one-time backfill (CL-3577): widen this poll's cutoff only
        // while the member has never had a Linear poll complete before.
        const isFirstLinearPoll =
          sourceKey === LINEAR_SOURCE_KEY &&
          typeof prefs[LINEAR_BACKFILL_APPLIED_PREFERENCE_KEY] !== "string";
        let sourceCutoff = cutoff;
        if (isFirstLinearPoll) {
          const backfill = prefs[LINEAR_BACKFILL_PREFERENCE_KEY];
          const windowMs =
            typeof backfill === "string"
              ? LINEAR_BACKFILL_WINDOW_MS[backfill]
              : undefined;
          if (windowMs !== undefined) {
            const widened = new Date(now() - windowMs);
            if (widened < sourceCutoff) sourceCutoff = widened;
          }
        }

        try {
          await runMemberSource(member, entry, sourceCutoff, prefs);
          if (isFirstLinearPoll) {
            await mergeMemberPreferences(
              deps.db,
              member.tenantId,
              member.memberPrincipalId,
              {
                [LINEAR_BACKFILL_APPLIED_PREFERENCE_KEY]: new Date(
                  now(),
                ).toISOString(),
              },
            );
          }
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
