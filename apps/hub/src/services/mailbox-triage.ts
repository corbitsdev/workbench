import { randomUUID } from "node:crypto";
import { eq, and, lt } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import { extractAttachments } from "@intx/mime";
import type {
  SessionService,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import type { CryptoProvider, MessageAttachment } from "@intx/types/runtime";
import type { TurnFinalized } from "@workbench/event-collector";
import { resolveAgentAutonomy, TRIAGE_SUBJECT_PREFIX } from "@workbench/shared";
import { splitMailAddress } from "@workbench/hub-agent";
import { resolveMailboxLoadout } from "@workbench/myra";
import type { HubDb } from "../db";
import { memberAgentInstance } from "../db/schema";
import { getConfig } from "../config";
import { isFeatureEnabledForTenantCached } from "../lib/feature-grants";
import { decodeMailFrame } from "../lib/mailbox-read";
import { slidingWindowLimiter } from "../lib/sliding-window";
import { writeMailboxMessage } from "../lib/mailbox-write";
import { divertInboundAttachments } from "../lib/mailbox-attachment-divert";
import type { MailboxEventBus } from "../lib/mailbox-events";
import { readMemberPreferences } from "../lib/member-preferences";
import type { UserMailboxRowEvent } from "../lib/principal-mailbox";
import { launchAgentSession } from "./agent-provisioning";
import {
  resolveMyraTriageDefinition,
  teardownThreadRows,
} from "./myra-threads";

const log = getLogger(["api", "mailbox-triage"]);

const { principal, agentInstance, tenant } = intxSchema;

// Exported so task-tools.ts can recognize a triage-created task and force it
// into `waiting` (see resolveTriageTaskDefaultStatus) without a second,
// driftable copy of this string.
export const TRIAGE_TEMPLATE_KEY = "myra-triage";

/**
 * Sender local-parts owned by system rails. Mail from these never triages:
 * `hub` frames are hub-authored notifications, and `myra` is the triage
 * handoff sender itself — triaging it would loop.
 */
const SYSTEM_SENDER_LOCAL_PARTS = new Set(["hub", "myra"]);

/**
 * Sender local-parts used by bounce/mailer-daemon rails. Mail from these
 * never triages — a triage handoff to a bounce address would either loop
 * (auto-reply to an auto-reply) or triage noise no human should see.
 * Matched case-insensitively, and against the base local-part with any
 * `+`-suffix stripped (e.g. `bounces+abc123` matches `bounces`).
 */
const BOUNCE_SENDER_LOCAL_PARTS = new Set([
  "mailer-daemon",
  "postmaster",
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
  "bounce",
  "bounces",
]);

const DEFAULT_TURN_TIMEOUT_MS = 180_000;

/**
 * Cap on in-flight-plus-queued triage items. Triage is single-flight and
 * strictly sequential, so a burst of inbound mail (or a stuck upstream
 * sender) can otherwise grow the queue without bound. On overflow the
 * oldest queued item is dropped rather than the persist path being blocked
 * or the newest arrival being refused.
 */
const MAX_QUEUE = 50;

/**
 * Per-tenant ceiling on triage session spawns per rolling hour. The queue and
 * single-flight processing bound how much can be in flight at once, but not
 * how many sessions a sustained mail loop spawns over a day — 30/hour is one
 * spawn per 2 minutes sustained, generous for real inbound traffic but far
 * below what an unattended loop would otherwise produce. Over budget, the
 * item is dropped with the same server-side-only visibility posture as queue
 * overflow (no member-facing error).
 */
const TRIAGE_MAX_SESSIONS_PER_HOUR = 30;
const TRIAGE_WINDOW_MS = 60 * 60 * 1000;

export type MailboxTriageDeps = {
  db: HubDb;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  cryptoProvider: CryptoProvider;
  /** Hard cap on how long one triage turn may run before teardown. */
  turnTimeoutMs?: number;
  mailboxEventBus?: MailboxEventBus;
  /** Clock injection point for the per-tenant spawn-budget window in tests. */
  now?: () => number;
};

export type MailboxTriage = {
  /**
   * Queue one inbound mailbox row for triage. Fire-and-forget: never throws,
   * never blocks the caller — eligibility, spawn, and handoff all happen on
   * the internal single-flight queue.
   */
  enqueue: (item: UserMailboxRowEvent) => void;
  /** Route a finalized turn to the triage session waiting on that address. */
  handleTurnFinalized: (agentAddress: string, turn: TurnFinalized) => void;
  /** Resolves once every queued item has fully processed. */
  waitForDrain: () => Promise<void>;
};

function localPart(address: string): string {
  return splitMailAddress(address)?.local ?? address;
}

function isSystemSender(item: UserMailboxRowEvent): boolean {
  return SYSTEM_SENDER_LOCAL_PARTS.has(localPart(item.senderAddress));
}

function isBounceSender(item: UserMailboxRowEvent): boolean {
  const local = localPart(item.senderAddress).toLowerCase();
  const base = local.split("+")[0] ?? local;
  return BOUNCE_SENDER_LOCAL_PARTS.has(base);
}

function isTriageHandoffSubject(item: UserMailboxRowEvent): boolean {
  return (item.subject ?? "").startsWith(TRIAGE_SUBJECT_PREFIX);
}

function buildTriageMessage(item: UserMailboxRowEvent): {
  content: string;
  inReplyTo: string | undefined;
  attachments: MessageAttachment[];
} {
  const decoded = decodeMailFrame(item.raw);
  const subject =
    decoded?.headers.get("subject") ?? item.subject ?? "(no subject)";
  const from = decoded?.headers.get("from") ?? item.fromAddress ?? "(unknown)";
  const date = decoded?.headers.get("date");
  const inReplyTo = decoded?.headers.get("message-id");
  const body = decoded?.body ?? "";
  const lines = [
    "Triage this inbound message.",
    "",
    `From: ${from}`,
    `To: ${item.recipientAddress}`,
    `Subject: ${subject}`,
    `Mailbox message id: ${item.rowId}`,
  ];
  if (date !== undefined) lines.push(`Date: ${date}`);
  lines.push("", body);
  return {
    content: lines.join("\n"),
    inReplyTo,
    attachments: extractAttachments(item.raw),
  };
}

/**
 * Ephemeral mailbox triage: when an eligible external message lands in a
 * member's inbox, spawn a one-shot Myra session mounted with the mailbox
 * persona, run one triage turn over that single item, write the handoff back
 * into the member's inbox, and tear the session down.
 *
 * Eligibility (checked per item, in order): the kill switch must be on; system
 * senders (hub/myra local-parts) never triage; bounce/mailer-daemon-style
 * senders (mailer-daemon, postmaster, no-reply, bounce(s), etc., including
 * `+`-suffixed variants) never triage; mail whose subject carries the triage
 * handoff prefix never triages (a structural signal that this is a handoff,
 * not fresh mail); mail from an agent instance ANY member in the tenant owns
 * — either directly (the instance principal IS that member, e.g. a workflow
 * deployment launched by them) or via a member_agent_instance mapping (a
 * Myra thread, triage or otherwise) — never triages, which also closes off
 * cross-member triage-to-triage ping-pong (each handoff would otherwise get
 * a fresh message_key, so dedupe alone can't stop a loop). Everything else
 * is external.
 *
 * The queue is bounded to one in-flight triage; items process strictly in
 * arrival order and a failure in one item never affects the next.
 */
export function createMailboxTriage(deps: MailboxTriageDeps): MailboxTriage {
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const sessionBudget = slidingWindowLimiter(
    TRIAGE_MAX_SESSIONS_PER_HOUR,
    TRIAGE_WINDOW_MS,
    deps.now,
  );
  const queue: UserMailboxRowEvent[] = [];
  const pending = new Map<string, (turn: TurnFinalized) => void>();
  const drainWaiters: (() => void)[] = [];
  let running = false;

  async function isEligible(item: UserMailboxRowEvent): Promise<boolean> {
    if (isSystemSender(item)) return false;
    if (isBounceSender(item)) return false;
    if (isTriageHandoffSubject(item)) return false;

    const sender = await deps.db.query.agentInstance.findFirst({
      where: eq(agentInstance.address, item.senderAddress),
    });
    if (!sender) return true;
    if (sender.principalId === item.memberPrincipalId) return false;

    // Any member's agent instance in the tenant — not just this member's —
    // is a terminal handoff sender. Without this, two members' triage Myras
    // can hand off to each other in a loop: each handoff mail gets a fresh
    // message_key, so dedupe alone never stops it.
    const mapping = await deps.db.query.memberAgentInstance.findFirst({
      where: and(
        eq(memberAgentInstance.instanceId, sender.id),
        eq(memberAgentInstance.tenantId, item.tenantId),
      ),
    });
    return mapping === undefined;
  }

  function awaitTurn(agentAddress: string): Promise<TurnFinalized | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(agentAddress);
        resolve(null);
      }, turnTimeoutMs);
      pending.set(agentAddress, (turn) => {
        clearTimeout(timer);
        pending.delete(agentAddress);
        resolve(turn);
      });
    });
  }

  async function runOne(item: UserMailboxRowEvent): Promise<void> {
    const eligible = await isEligible(item);
    if (!eligible) return;

    const def = await resolveMyraTriageDefinition(deps.db, item.tenantId);
    if (!def) {
      log.error(
        "Mailbox triage skipped: no Myra Triage definition for {tenantId}",
        { tenantId: item.tenantId },
      );
      return;
    }

    const tenantRow = await deps.db.query.tenant.findFirst({
      where: eq(tenant.id, item.tenantId),
    });
    if (!tenantRow?.domain) {
      log.error("Mailbox triage skipped: tenant {tenantId} has no domain", {
        tenantId: item.tenantId,
      });
      return;
    }
    const tenantDomain = tenantRow.domain;

    const prefs = await readMemberPreferences(
      deps.db,
      item.tenantId,
      item.memberPrincipalId,
    );
    const autonomy = resolveAgentAutonomy(prefs);
    // Default true (see the `tasksTriageCreate` registry entry): a member who
    // has never touched the setting keeps getting the tasks triage already
    // prepares today.
    const tasksEnabled = prefs.tasksTriageCreate !== false;
    const loadout = resolveMailboxLoadout(autonomy, tasksEnabled);

    const now = new Date();
    const instanceId = generateId("instance");
    const mappingId = generateId("instance");
    const instancePrincipalId = generateId("principal");
    const subject = item.subject ?? "(no subject)";

    await deps.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as HubDb;
      await tx.insert(principal).values({
        id: instancePrincipalId,
        tenantId: item.tenantId,
        kind: "agent",
        refId: instanceId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(agentInstance).values({
        id: instanceId,
        agentId: def.id,
        tenantId: item.tenantId,
        principalId: instancePrincipalId,
        address: `${instanceId}@${tenantDomain}`,
        status: "deployed",
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(memberAgentInstance).values({
        id: mappingId,
        tenantId: item.tenantId,
        memberPrincipalId: item.memberPrincipalId,
        templateKey: TRIAGE_TEMPLATE_KEY,
        agentId: def.id,
        instanceId,
        label: `Triage: ${subject}`,
        createdAt: now,
        lastActivityAt: now,
      });
    });

    let address: string | undefined;
    try {
      const launched = await launchAgentSession(
        deps.db,
        deps.sessionService,
        deps.grantStore,
        deps.eventCollectors,
        {
          agentId: def.id,
          instanceId,
          instancePrincipalId,
          tenantId: item.tenantId,
          tenantDomain,
          systemPrompt: loadout.systemPrompt,
          persona: { toolNames: loadout.toolNames },
          now,
        },
      );
      address = launched.address;

      const { content, inReplyTo, attachments } = buildTriageMessage(item);
      // A text-only (or otherwise attachment-incapable) triage agent must
      // never receive an inline content block it can't consume — divert
      // through the File Parser instead (see `mailbox-attachment-divert.ts`).
      // Vision-capable definitions keep every attachment inline unchanged.
      const { inlineAttachments, contextBlocks } =
        await divertInboundAttachments(deps.db, {
          tenantId: item.tenantId,
          ownerPrincipalId: item.memberPrincipalId,
          agentRow: def,
          attachments,
        });
      const turnContent =
        contextBlocks.length > 0
          ? `${contextBlocks.join("\n\n")}\n\n${content}`
          : content;

      // Register the waiter BEFORE the send so a fast turn cannot finalize
      // into a gap where nothing is listening.
      const turnPromise = awaitTurn(address);
      await deps.sessionService.sendUserMessage({
        agentAddress: address,
        from: `hub@${tenantDomain}`,
        messageId: randomUUID(),
        date: new Date(),
        content: turnContent,
        sessionId: launched.sessionId,
        tenantId: item.tenantId,
        cryptoProvider: deps.cryptoProvider,
        ...(inlineAttachments.length > 0
          ? { attachments: inlineAttachments }
          : {}),
      });

      const turn = await turnPromise;
      if (turn === null) {
        log.error("Mailbox triage turn timed out for {rowId}", {
          rowId: item.rowId,
          instanceId,
        });
        return;
      }
      const text = turn.text?.trim() ?? "";
      if (turn.status !== "completed" || text === "") {
        log.error("Mailbox triage turn produced no handoff for {rowId}", {
          rowId: item.rowId,
          instanceId,
          status: turn.status,
        });
        return;
      }

      await writeMailboxMessage(
        deps.db,
        {
          tenantId: item.tenantId,
          principalId: item.memberPrincipalId,
          address: item.recipientAddress,
          fromAddress: `myra@${tenantDomain}`,
          subject: `${TRIAGE_SUBJECT_PREFIX}${subject}`,
          body: text,
          messageKey: `triage:${item.rowId}`,
          // Links the handoff to the raw mail it triaged, so the Now feed can
          // collapse the pair by ref instead of the old subject-prefix match.
          refs: [{ kind: "mail", ref: item.rowId, label: `Open: ${subject}` }],
          ...(inReplyTo !== undefined ? { inReplyTo } : {}),
        },
        deps.mailboxEventBus,
      );
    } finally {
      // `endSession` sends the sidecar an `agent.undeploy` frame; the sidecar
      // handler (`handleAgentUndeploy`) both stops the harness AND deletes the
      // on-disk agent directory (`deleteAgentDir`) — the same directory
      // `restoreSessions()` scans on reconnect to decide which addresses are
      // wakeable. A successful `endSession` is therefore the actual
      // deprovision: nothing sidecar-side survives to be re-registered.
      //
      // Only hard-delete the DB rows (`teardownThreadRows`) once that
      // succeeded, or once nothing was ever launched (`address === undefined`
      // — no sidecar-side state exists to leak). If `endSession` fails (e.g.
      // the sidecar is mid-reconnect), deleting the DB rows anyway would
      // orphan the on-disk directory with no record left to retry
      // deprovisioning it — that's the mechanism behind triage Myras "staying
      // registered forever". Leaving the rows in place lets the boot sweep
      // (`sweepStaleTriageInstances`) retry `endSession` later.
      //
      // This is distinct from the idle-session-reaper's chat-sleep, which
      // deliberately leaves the `agent_instance` row relaunchable so a
      // member's conversation history survives a sleep/wake cycle. A triage
      // instance retains no conversation anyone revisits — full retirement
      // (session end + row deletion) is the correct terminal state, not a
      // park.
      let sessionEnded = address === undefined;
      if (address !== undefined) {
        pending.delete(address);
        try {
          await deps.sessionService.endSession(address, "mailbox_triage_done");
          sessionEnded = true;
        } catch (err) {
          log.warn(
            "Mailbox triage session end failed; leaving instance for the boot sweep to retry",
            {
              instanceId,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
      }
      if (sessionEnded) {
        try {
          await teardownThreadRows(deps.db, {
            instanceId,
            mappingId,
            instancePrincipalId,
          });
        } catch (err) {
          log.error("Mailbox triage teardown failed for {instanceId}", {
            instanceId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }
  }

  function pump(): void {
    if (running) return;
    running = true;
    void drainQueue();
  }

  async function drainQueue(): Promise<void> {
    try {
      let next = queue.shift();
      while (next !== undefined) {
        // Re-check per item, by the ITEM'S tenant, so flipping the tenant's
        // feature grant off also stops that tenant's backlog (not just new
        // arrivals), while another tenant's queued items are unaffected. The
        // env override is checked first and synchronously: when it is on,
        // every tenant is enabled and the async grant lookup is skipped
        // entirely (matches the pre-existing fast path).
        if (!getConfig().triageEnabled) {
          const enabled = await isFeatureEnabledForTenantCached(
            deps.db,
            next.tenantId,
            "triage",
            false,
          );
          if (!enabled) {
            next = queue.shift();
            continue;
          }
        }
        if (!sessionBudget.tryAcquire(next.tenantId)) {
          log.error("Mailbox triage session budget exceeded; dropped item", {
            tenantId: next.tenantId,
            rowId: next.rowId,
            maxSessionsPerHour: TRIAGE_MAX_SESSIONS_PER_HOUR,
          });
          next = queue.shift();
          continue;
        }
        try {
          await runOne(next);
        } catch (err) {
          log.error("Mailbox triage failed for {rowId}", {
            rowId: next.rowId,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
        next = queue.shift();
      }
    } finally {
      running = false;
      for (const resolve of drainWaiters.splice(0)) resolve();
    }
  }

  return {
    enqueue(item) {
      // `enqueue` is a fire-and-forget hook off a mail-arrival event and must
      // stay synchronous, so it cannot make the authoritative (env OR
      // per-tenant grant) check itself — that check runs in `drainQueue` at
      // dequeue instead, which drops the item there if the item's tenant has
      // triage disabled. Queueing an item whose tenant turns out to be
      // disabled is a harmless no-op (dropped before `runOne`).
      if (queue.length >= MAX_QUEUE) {
        const dropped = queue.shift();
        log.error("Mailbox triage queue full; dropped oldest item", {
          droppedRowId: dropped?.rowId,
          maxQueue: MAX_QUEUE,
        });
      }
      queue.push(item);
      pump();
    },
    handleTurnFinalized(agentAddress, turn) {
      pending.get(agentAddress)?.(turn);
    },
    async waitForDrain() {
      if (!running && queue.length === 0) return;
      await new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },
  };
}

/** Age past which a leftover `myra-triage` instance is swept as backlog. */
const TRIAGE_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Bound on rows retired per sweep pass. Bookkeeping cleanup, not a hot path —
 * a large one-off backlog drains over a few boot cycles rather than blocking
 * hub startup.
 */
const TRIAGE_SWEEP_LIMIT = 500;

/**
 * Idempotent boot-time cleanup for `myra-triage` instances `runOne` could not
 * fully retire (its `endSession` call failed, so it left the DB rows in
 * place for a retry rather than orphaning the sidecar-side directory — see
 * the comment in `runOne`'s `finally` block). Targets rows by age rather than
 * a status column: a leftover row's `agent_instance` is still `deployed`
 * (nothing here ever demotes it, since the whole point of leaving it behind
 * was to retry the SAME deprovision path), so age since creation is the only
 * available staleness signal. Real triage runs finish in well under an hour;
 * `TRIAGE_STALE_AFTER_MS` gives a wide margin so this never races a run still
 * in flight.
 *
 * Each row gets a best-effort `endSession` retry, then its DB rows are
 * deleted unconditionally — unlike `runOne`, indefinite retry has no payoff
 * for rows this old (the sidecar has very likely long since disconnected,
 * reconnected, or been redeployed since they were created), so the sweep is
 * the backstop that guarantees the backlog actually drains rather than
 * accumulating retries forever. Bounded by `TRIAGE_SWEEP_LIMIT` and logged
 * once per pass; a second pass over an already-clean backlog finds nothing
 * and is a no-op.
 */
export async function sweepStaleTriageInstances(
  db: HubDb,
  sessionService: Pick<SessionService, "endSession">,
  opts?: { staleAfterMs?: number; limit?: number; now?: () => number },
): Promise<{ scanned: number; retired: number }> {
  const staleAfterMs = opts?.staleAfterMs ?? TRIAGE_STALE_AFTER_MS;
  const limit = opts?.limit ?? TRIAGE_SWEEP_LIMIT;
  const nowFn = opts?.now ?? (() => Date.now());
  const cutoff = new Date(nowFn() - staleAfterMs);

  const stale = await db
    .select({
      mappingId: memberAgentInstance.id,
      instanceId: memberAgentInstance.instanceId,
      instancePrincipalId: agentInstance.principalId,
      address: agentInstance.address,
    })
    .from(memberAgentInstance)
    .innerJoin(
      agentInstance,
      eq(memberAgentInstance.instanceId, agentInstance.id),
    )
    .where(
      and(
        eq(memberAgentInstance.templateKey, TRIAGE_TEMPLATE_KEY),
        lt(memberAgentInstance.createdAt, cutoff),
      ),
    )
    .limit(limit);

  let retired = 0;
  let deferred = 0;
  for (const row of stale) {
    try {
      await sessionService.endSession(row.address, "mailbox_triage_boot_sweep");
    } catch (err) {
      // Same rule as runOne's teardown: rows are only deleted once the
      // sidecar undeploy succeeded. At hub boot the sidecar is often not
      // reconnected yet and endSession rejects immediately — deleting the
      // rows then would orphan the on-disk agent dir with no record, the
      // exact leak this sweep exists to drain. Leave the row; the next
      // boot's sweep retries.
      deferred += 1;
      log.warn(
        "Triage boot sweep: endSession failed; keeping rows for a later retry",
        {
          instanceId: row.instanceId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
      continue;
    }
    try {
      await teardownThreadRows(db, {
        instanceId: row.instanceId,
        mappingId: row.mappingId,
        instancePrincipalId: row.instancePrincipalId,
      });
      retired += 1;
    } catch (err) {
      log.error("Triage boot sweep: teardown failed for {instanceId}", {
        instanceId: row.instanceId,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  log.info("Triage boot sweep complete", {
    scanned: stale.length,
    retired,
    deferred,
  });
  return { scanned: stale.length, retired };
}
