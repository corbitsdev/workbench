import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import { generateId } from "@intx/hub-common";
import { getLogger } from "@intx/log";
import type {
  SessionService,
  EventCollectorRegistry,
} from "@intx/hub-sessions";
import type { GrantStore } from "@intx/types/authz";
import type { CryptoProvider } from "@intx/types/runtime";
import type { TurnFinalized } from "@workbench/event-collector";
import { resolveAgentAutonomy } from "@workbench/shared";
import { resolveMailboxLoadout } from "@workbench/myra";
import type { HubDb } from "../db";
import { memberAgentInstance } from "../db/schema";
import { getConfig } from "../config";
import { decodeMailFrame } from "../lib/mailbox-read";
import { writeMailboxMessage } from "../lib/mailbox-write";
import { readMemberPreferences } from "../lib/member-preferences";
import type { UserMailboxRowEvent } from "../lib/principal-mailbox";
import { launchAgentSession } from "./agent-provisioning";
import { resolveMyraDefinition, teardownThreadRows } from "./myra-threads";

const log = getLogger(["api", "mailbox-triage"]);

const { principal, agentInstance, tenant } = intxSchema;

export const TRIAGE_TEMPLATE_KEY = "myra-triage";

/**
 * Sender local-parts owned by system rails. Mail from these never triages:
 * `hub` frames are hub-authored notifications, and `myra` is the triage
 * handoff sender itself — triaging it would loop.
 */
const SYSTEM_SENDER_LOCAL_PARTS = new Set(["hub", "myra"]);

const DEFAULT_TURN_TIMEOUT_MS = 180_000;

export type MailboxTriageDeps = {
  db: HubDb;
  sessionService: SessionService;
  grantStore: GrantStore;
  eventCollectors: EventCollectorRegistry;
  cryptoProvider: CryptoProvider;
  /** Hard cap on how long one triage turn may run before teardown. */
  turnTimeoutMs?: number;
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
  const at = address.indexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

function buildTriageMessage(item: UserMailboxRowEvent): {
  content: string;
  inReplyTo: string | undefined;
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
  ];
  if (date !== undefined) lines.push(`Date: ${date}`);
  lines.push("", body);
  return { content: lines.join("\n"), inReplyTo };
}

/**
 * Ephemeral mailbox triage: when an eligible external message lands in a
 * member's inbox, spawn a one-shot Myra session mounted with the mailbox
 * persona, run one triage turn over that single item, write the handoff back
 * into the member's inbox, and tear the session down.
 *
 * Eligibility (checked per item, in order): the kill switch must be on; system
 * senders (hub/myra local-parts) never triage; mail from an agent instance the
 * member owns — either directly (the instance principal IS the member, e.g. a
 * workflow deployment launched by them) or via a member_agent_instance mapping
 * (their own Myra threads) — never triages. Everything else is external.
 *
 * The queue is bounded to one in-flight triage; items process strictly in
 * arrival order and a failure in one item never affects the next.
 */
export function createMailboxTriage(deps: MailboxTriageDeps): MailboxTriage {
  const turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const queue: UserMailboxRowEvent[] = [];
  const pending = new Map<string, (turn: TurnFinalized) => void>();
  const drainWaiters: Array<() => void> = [];
  let running = false;

  async function isEligible(item: UserMailboxRowEvent): Promise<boolean> {
    if (SYSTEM_SENDER_LOCAL_PARTS.has(localPart(item.senderAddress))) {
      return false;
    }
    const sender = await deps.db.query.agentInstance.findFirst({
      where: eq(agentInstance.address, item.senderAddress),
    });
    if (!sender) return true;
    if (sender.principalId === item.memberPrincipalId) return false;
    const mapping = await deps.db.query.memberAgentInstance.findFirst({
      where: and(
        eq(memberAgentInstance.instanceId, sender.id),
        eq(memberAgentInstance.memberPrincipalId, item.memberPrincipalId),
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

    const def = await resolveMyraDefinition(deps.db, item.tenantId);
    if (!def) {
      log.error("Mailbox triage skipped: no Myra definition for {tenantId}", {
        tenantId: item.tenantId,
      });
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
    const loadout = resolveMailboxLoadout(autonomy);

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

      const { content, inReplyTo } = buildTriageMessage(item);
      // Register the waiter BEFORE the send so a fast turn cannot finalize
      // into a gap where nothing is listening.
      const turnPromise = awaitTurn(address);
      await deps.sessionService.sendUserMessage({
        agentAddress: address,
        from: `hub@${tenantDomain}`,
        messageId: randomUUID(),
        date: new Date(),
        content,
        sessionId: launched.sessionId,
        tenantId: item.tenantId,
        cryptoProvider: deps.cryptoProvider,
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

      await writeMailboxMessage(deps.db, {
        tenantId: item.tenantId,
        principalId: item.memberPrincipalId,
        address: item.recipientAddress,
        fromAddress: `myra@${tenantDomain}`,
        subject: `Myra triaged: ${subject}`,
        body: text,
        messageKey: `triage:${item.rowId}`,
        ...(inReplyTo !== undefined ? { inReplyTo } : {}),
      });
    } finally {
      if (address !== undefined) {
        pending.delete(address);
        try {
          await deps.sessionService.endSession(address, "mailbox_triage_done");
        } catch (err) {
          log.warn("Mailbox triage session end failed; tearing down rows", {
            instanceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
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

  function pump(): void {
    if (running) return;
    running = true;
    void drainQueue();
  }

  async function drainQueue(): Promise<void> {
    try {
      let next = queue.shift();
      while (next !== undefined) {
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
      if (!getConfig().triageEnabled) return;
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
