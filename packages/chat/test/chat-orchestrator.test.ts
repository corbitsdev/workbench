// Proves the orchestrator's own wiring: a `connector.reply` on the
// shared `agent.event` stream resolves the replying address to its
// folded run, finds every workbench whose participants carry that
// address (defensively — more than one, if the store ever shows it),
// and posts the reply into each via `platform.sendMail` with
// `fromWorkbenchId` set to the agent's own run id. Non-reply events are
// ignored for posting but still bump activity; an address the store
// never produced (no folded run) is ignored outright; `dispose` stops
// the subscription.
//
// Also proves the `reactor.gate.blocked` -> approve-block wiring: an
// approval-gate park resolves its `correlationId` to the platform's own
// approval row and posts an `{type:"approve"}` block carrying that row's
// id and headline; a redelivered event, or one for an approval already
// resolved, posts nothing more.
import { describe, expect, test } from "bun:test";
import { createSidecarEmitter } from "@intx/hub-sessions";
import {
  createArtifactDeliveryHandler,
  createChatOrchestrator,
} from "../src/chat-orchestrator";
import { parseBlock } from "../src/blocks";
import { decodeParts, type MailContent } from "../src/codec";
import type { WorkbenchSettingsRow } from "../src/store";
import { createInMemoryWriteClaimStore } from "../src/write-claims";

// A fresh claim store per test, unless a test explicitly wants to share
// one across two separately-constructed orchestrators/handlers to prove
// a claim survives what a hub restart looks like from their point of
// view (see the "restart-shaped redelivery" tests below).
function fakeClaims() {
  return createInMemoryWriteClaimStore();
}

function approvalRow(overrides?: {
  id?: string;
  status?: "pending" | "approved" | "rejected" | "timeout" | "expired";
}) {
  return {
    id: overrides?.id ?? "apr_1",
    tenantId: "ten_1",
    anchorRunId: "ins_echo1",
    runId: "ins_echo1",
    agentAddress: "ins_echo1@ten1.workbench.test",
    correlationId: "cor_1",
    toolDefinition: { name: "post_to_slack", description: "Post to Slack" },
    toolArguments: {},
    scope: null,
    status: overrides?.status ?? "pending",
    timeoutAt: null,
    resolvedAt: null,
    createdAt: new Date("2026-08-08T09:00:00.000Z"),
    updatedAt: new Date("2026-08-08T09:00:00.000Z"),
  } as const;
}

// The real `findFoldedRunByAddress` (exercised, not mocked, so this
// file never risks poisoning `@corbits/folded-runs`'s module namespace
// for `platform-adapter.test.ts` when the whole package's suite runs
// in one process) calls `db.query.workflowRun.findFirst({ where:
// eq(workflowRun.address, address) })`. Every scenario here configures
// at most one run, so this fake ignores the `where` filter and simply
// returns the configured run regardless of which address was queried
// — the same convention `platform-adapter.test.ts`'s own fake `db`
// uses.
function createFakeDb(run?: {
  id: string;
  tenantId: string;
  principalId?: string | null;
}) {
  return {
    query: {
      workflowRun: {
        findFirst: async () =>
          run === undefined
            ? undefined
            : { ...run, principalId: run.principalId ?? null },
      },
    },
  };
}

function fakeMemory() {
  const added: unknown[] = [];
  return {
    memory: {
      async add(params: unknown) {
        added.push(params);
        return { documentId: "doc_1", versionId: "ver_1" };
      },
    },
    added,
  };
}

function workbenchRow(
  workbenchId: string,
  participantAddresses: string[],
): WorkbenchSettingsRow {
  return {
    tenantId: "ten_1",
    workbenchId,
    settings: {
      "chat/kind": "workbench",
      "chat/participants": participantAddresses.map((address) => ({
        address,
        handle: address.split("@")[0],
      })),
    },
    updatedBy: "prn_1",
    updatedAt: new Date(),
  };
}

describe("createChatOrchestrator", () => {
  test("posts a connector.reply into the member workbench resolved from the store", async () => {
    const sentMail: {
      tenantId: string;
      workbenchId: string;
      content: unknown;
      fromWorkbenchId?: string;
    }[] = [];
    const listWorkbenchSettingsCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async (tenantId) => {
          listWorkbenchSettingsCalls.push(tenantId);
          return [
            workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
          ];
        },
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input as never);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hello back" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listWorkbenchSettingsCalls).toEqual(["ten_1"]);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      fromWorkbenchId: "ins_echo1",
    });

    orchestrator.dispose();
  });

  test("the host's reply mentioning a specialist fans out to that specialist too — the delegation hop", async () => {
    const sentMail: {
      tenantId: string;
      workbenchId: string;
      content: unknown;
      fromWorkbenchId?: string;
    }[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_myra1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [
            "ins_myra1@ten1.workbench.test",
            "ins_echo1@ten1.workbench.test",
          ]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input as never);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "@ins_echo1 can you take this one" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(2);
    expect(sentMail[0]).toMatchObject({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      fromWorkbenchId: "ins_myra1",
    });
    expect(sentMail[1]).toMatchObject({
      tenantId: "ten_1",
      workbenchId: "ins_echo1",
      fromWorkbenchId: "ins_workbench1",
    });

    orchestrator.dispose();
  });

  test("a delegated specialist's reply threads under the delegating message; the host's own replies stay in main (CL-5879)", async () => {
    const sentMail: { workbenchId: string; fromWorkbenchId?: string }[] = [];
    const assignments: {
      tenantId: string;
      workbenchId: string;
      threadId: string;
      messageId: string;
    }[] = [];
    const openedThreadFor: string[] = [];
    const events = createSidecarEmitter();

    // `findFoldedRunByAddress` is exercised for real (see this file's
    // header comment), so this fake answers by call order rather than
    // inspecting the drizzle `where` expression: the host's own event
    // resolves first, the delegated specialist's reply second — exactly
    // the order this test emits them in.
    const runsByCallOrder = [
      { id: "ins_myra1", tenantId: "ten_1" },
      { id: "ins_echo1", tenantId: "ten_1" },
    ];
    let dbCallIndex = 0;
    const db = {
      query: {
        workflowRun: {
          findFirst: async () => {
            const run = runsByCallOrder[dbCallIndex];
            dbCallIndex += 1;
            return run === undefined
              ? undefined
              : { ...run, principalId: null };
          },
        },
      },
    };

    const orchestrator = createChatOrchestrator({
      db: db as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", [
            "ins_myra1@ten1.workbench.test",
            "ins_echo1@ten1.workbench.test",
          ]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push({
            workbenchId: input.workbenchId,
            ...(input.fromWorkbenchId !== undefined
              ? { fromWorkbenchId: input.fromWorkbenchId }
              : {}),
          });
          return {
            id: `mail_${sentMail.length}`,
            createdAt: new Date().toISOString(),
          };
        },
      },
      threads: {
        openReplyThread: async (input) => {
          openedThreadFor.push(input.parentMessageId);
          return {
            id: "thr_1",
            tenantId: input.tenantId,
            workbenchId: input.workbenchId,
            kind: "reply",
            parentMessageId: input.parentMessageId,
            parentThreadId: "thr_root",
            runRef: null,
            title: null,
            createdAt: new Date(),
          };
        },
        assignMessage: async (input) => {
          assignments.push(input);
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // The host (Myra) replies, delegating to the specialist by @mention.
    events.emit("agent.event", {
      agentAddress: "ins_myra1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "connector.reply",
        data: { content: "@ins_echo1 can you take this one" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The delegating message is mail_1, posted into ins_workbench1.
    expect(sentMail[0]).toMatchObject({
      workbenchId: "ins_workbench1",
      fromWorkbenchId: "ins_myra1",
    });
    // No thread assignment yet — only the specialist's own reply threads.
    expect(assignments).toHaveLength(0);

    // The specialist wakes, does its deep-dive, and replies.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_2",
      event: {
        type: "connector.reply",
        data: { content: "Done — filed the ticket." },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The specialist's reply lands in the same main workbench as the host...
    const specialistReply = sentMail.find(
      (m) => m.fromWorkbenchId === "ins_echo1",
    );
    expect(specialistReply).toMatchObject({ workbenchId: "ins_workbench1" });
    // ...but is threaded under the delegating message (mail_1), not left
    // loose on the root feed.
    expect(openedThreadFor).toEqual(["mail_1"]);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      threadId: "thr_1",
    });

    orchestrator.dispose();
  });

  test("posts into every workbench when the store shows the address in more than one", async () => {
    const sentMail: { workbenchId: string }[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
          workbenchRow("ins_workbench2", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push({ workbenchId: input.workbenchId });
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail.map((m) => m.workbenchId).sort()).toEqual([
      "ins_workbench1",
      "ins_workbench2",
    ]);

    orchestrator.dispose();
  });

  // CL-6137 / turn-drop notice (stress round 3): a turn that never
  // emits `connector.reply` content is no longer invisible — the
  // bracket close posts an honest in-workbench notice — but a reply this
  // process already saw for the turn is never followed by a redundant
  // notice, and a redelivered bracket-close event posts at most one.
  test("message.run.ended posts a notice only for a turn that ended with no reply, once per redelivery", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // Turn 1: a reply, then its own bracket close — one post, from the
    // reply alone, no notice on top of it.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.ended", data: { status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMail).toHaveLength(1);

    // Turn 2: a silent completion — no reply this process ever saw for
    // it — posts the honest empty-turn notice.
    const silentEnd = {
      type: "message.run.ended",
      data: { status: "completed" },
    };
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: silentEnd,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMail).toHaveLength(2);
    expect(
      decodeParts((sentMail[1] as { content: MailContent }).content),
    ).toEqual([
      {
        kind: "text",
        text: "I didn't manage to answer that one — say it again and I'll pick it up.",
      },
    ]);

    // Turn 2's end event redelivered (sidecar reconnect, wire-layer
    // replay) — no second notice.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: silentEnd,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMail).toHaveLength(2);

    // Turn 3: a fresh reply after the silent turn 2 still posts — the
    // bracket-close bookkeeping never leaves stale state behind.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi again" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMail).toHaveLength(3);

    orchestrator.dispose();
  });

  // CL-turn-drop-root: two silent turns back to back (no reply either
  // time — a real, if rare, inference outcome under load, not just a
  // redelivery of the same bracket-close) must each get their own
  // notice. Before this fix, `notifiedDropAddresses` only cleared on a
  // real `connector.reply`, so the second silent turn's notice was
  // swallowed by the guard the first silent turn left set — a user
  // sending consecutive messages during a rough patch saw exactly one
  // notice ever, then total silence with no trace anywhere.
  test("message.run.ended posts a notice for EACH silent turn, not just the first", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    // Turn 1: silent completion, no reply — posts the notice.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.ended", data: { status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMail).toHaveLength(1);

    // Turn 2 opens (a genuinely new message, not a redelivery) —
    // re-arms the notice guard for this fresh turn.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.started", data: { messageId: "m2" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Turn 2 also ends silently — must post its OWN notice, not be
    // swallowed by turn 1's already-set guard.
    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "message.run.ended", data: { status: "completed" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMail).toHaveLength(2);

    orchestrator.dispose();
  });

  test("message.run.ended posts the extracted error text for a failed turn", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "message.run.ended",
        data: { status: "failed", error: { message: "provider timed out" } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(1);
    expect(
      decodeParts((sentMail[0] as { content: MailContent }).content),
    ).toEqual([{ kind: "text", text: "provider timed out" }]);

    orchestrator.dispose();
  });

  test("ignores non-reply events for posting but still bumps activity", async () => {
    const sentMail: unknown[] = [];
    const recordActivityCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: { listWorkbenchSettings: async () => [] },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
      recordActivity: (address) => recordActivityCalls.push(address),
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.turn.started", data: {} },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);
    expect(recordActivityCalls).toEqual(["ins_echo1@ten1.workbench.test"]);

    orchestrator.dispose();
  });

  test("ignores an address with no folded run", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb(undefined) as never,
      store: { listWorkbenchSettings: async () => [] },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "unknown@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);

    orchestrator.dispose();
  });

  test("dispose unsubscribes from the event stream", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    orchestrator.dispose();

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);
  });

  test("posts an approve block for a gate-blocked approval, keyed off the platform's own row", async () => {
    const sentMail: {
      tenantId: string;
      workbenchId: string;
      content: unknown;
      fromWorkbenchId?: string;
    }[] = [];
    const findByCorrelationIdCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input as never);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      claims: fakeClaims(),
      approvals: {
        findByCorrelationId: async (correlationId) => {
          findByCorrelationIdCalls.push(correlationId);
          return approvalRow();
        },
      },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "approval", gateId: "gate_1", correlationId: "cor_1" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(findByCorrelationIdCalls).toEqual(["cor_1"]);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({
      tenantId: "ten_1",
      workbenchId: "ins_workbench1",
      fromWorkbenchId: "ins_echo1",
    });

    const parts = decodeParts(sentMail[0]?.content as never);
    expect(parts).toHaveLength(1);
    const part = parts[0];
    if (part?.kind !== "block") throw new Error("expected a block part");
    const parsed = parseBlock(part.block);
    if (!parsed.ok) throw new Error(parsed.summary);
    expect(parsed.block).toEqual({
      type: "approve",
      data: { approvalId: "apr_1", title: "Post to Slack" },
    });

    orchestrator.dispose();
  });

  test("ignores a gate-blocked event for a non-approval gate", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      claims: fakeClaims(),
      approvals: {
        findByCorrelationId: async () => {
          throw new Error("should never be consulted for a non-approval gate");
        },
      },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "budget", gateId: "gate_1", correlationId: "cor_1" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);

    orchestrator.dispose();
  });

  test("a redelivered gate-blocked event does not post a second card", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => approvalRow() },
    });

    const emitGateBlocked = () =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: {
          type: "reactor.gate.blocked",
          data: {
            reason: "approval",
            gateId: "gate_1",
            correlationId: "cor_1",
          },
        },
      });

    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitGateBlocked();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(1);

    orchestrator.dispose();
  });

  test("a gate-blocked event for an already-resolved approval posts nothing", async () => {
    const sentMail: unknown[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
      claims: fakeClaims(),
      approvals: {
        findByCorrelationId: async () => approvalRow({ status: "approved" }),
      },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: {
        type: "reactor.gate.blocked",
        data: { reason: "approval", gateId: "gate_1", correlationId: "cor_1" },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);

    orchestrator.dispose();
  });
});

describe("createArtifactDeliveryHandler", () => {
  test("posts a FilePart into every member workbench for a finalized turn naming a persisted artifact", async () => {
    const sentMail: { workbenchId: string; content: unknown }[] = [];
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push({
            workbenchId: input.workbenchId,
            content: input.content,
          });
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]?.workbenchId).toBe("ins_workbench1");
    const decodedParts = decodeParts(sentMail[0]?.content as MailContent);
    expect(decodedParts).toEqual([
      {
        kind: "file",
        name: "Notes",
        mediaType: "text/plain",
        artifactId: "art_1",
      },
    ]);
  });

  test("sends nothing when the turn's tool calls name no persisted artifact", async () => {
    const sentMail: unknown[] = [];
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [{ isError: false, result: "{}" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);
  });

  test("records a memory entry for a persisted artifact, attributed to the run's own tenant + principal — never a model-supplied value", async () => {
    const { memory, added } = fakeMemory();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      memory,
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          // A model-supplied tenantId/principalId in the tool result must
          // never override the run's own authenticated identity — the
          // recognized shape doesn't even carry those fields, so there is
          // nothing to override with.
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toEqual([
      {
        tenantId: "ten_1",
        principalId: "prn_1",
        kind: "artifact",
        content: {
          title: "Notes",
          text: 'Library artifact "Notes" (text) was created.',
        },
        attributes: { artifactId: "art_1" },
      },
    ]);
  });

  test("records nothing when the memory plane is not mounted", async () => {
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });

    // No throw, no memory dependency touched — `deps.memory` is absent.
    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test("records nothing when the run has no principal to attribute the entry to", async () => {
    const { memory, added } = fakeMemory();
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: null,
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      memory,
    });

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(0);
  });

  // CL-6039: mirrors `createChatOrchestrator`'s own "a redelivered
  // gate-blocked event does not post a second card" test above, but for
  // the finalized-turn write surfaces, and one step further —
  // `postedApprovalIds` there is a plain `Set` scoped to one
  // orchestrator instance, so that test only proves same-process
  // redelivery is deduped. Here the SAME `claims` store is handed to two
  // separately-constructed handlers, simulating what a hub restart looks
  // like from the write surfaces' point of view (a fresh process, a
  // fresh in-memory `Set` if there were one — but the durable claim
  // table survives), proving the dedup holds even then.
  test("a redelivered finalized turn posts no second FilePart and records no second memory entry, even across a restart-shaped new handler instance", async () => {
    const sentMail: unknown[] = [];
    const { memory, added } = fakeMemory();
    const claims = fakeClaims();
    const deps = {
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => {
          sentMail.push(1);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events: createSidecarEmitter(),
      claims,
      memory,
    };
    const turn = {
      turnId: "turn_restart_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    };

    const firstHandler = createArtifactDeliveryHandler(deps);
    firstHandler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A brand-new handler, built fresh the way the hub would after a
    // restart — but backed by the same durable `claims` store.
    const secondHandler = createArtifactDeliveryHandler(deps);
    secondHandler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(1);
    expect(added).toHaveLength(1);
  });

  // CL-6039 (critique follow-up): a claim won for one artifact must not
  // outlive a write that never happened. Before the release-on-failure
  // fix, the turn-wide claim meant the SECOND artifact's failure would
  // have permanently lost that entry (claim already held, redelivery
  // skips it) while the FIRST artifact's success was never at risk of
  // duplication in the first place — this test inverts that scenario:
  // proves the failed entry recovers on redelivery, and the succeeded
  // one is still not duplicated.
  test("a mid-loop memory.add failure loses no entry: the failed artifact recovers on redelivery, the one that already succeeded is not duplicated", async () => {
    const added: unknown[] = [];
    let addCalls = 0;
    const memory = {
      async add(params: unknown) {
        addCalls += 1;
        if (addCalls === 2) throw new Error("simulated memory.add failure");
        added.push(params);
        return { documentId: "doc_1", versionId: "ver_1" };
      },
    };
    const deps = {
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({
        id: "run_1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      memory,
    };
    const turn = {
      turnId: "turn_partial_1",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "First",
            kind: "text",
            persisted: true,
          }),
        },
        {
          isError: false,
          result: JSON.stringify({
            id: "art_2",
            version: 1,
            title: "Second",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    };
    const handler = createArtifactDeliveryHandler(deps);

    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // art_1 recorded; art_2's add threw, releasing its claim.
    expect(added).toHaveLength(1);
    expect(
      (added[0] as { attributes: { artifactId: string } }).attributes
        .artifactId,
    ).toBe("art_1");

    // Redelivery: art_1's claim is still held (skipped, not re-added);
    // art_2's claim was released, so it is retried and this time
    // succeeds (addCalls no longer lands on the throwing 2nd call).
    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(2);
    expect(
      added
        .map(
          (entry) =>
            (entry as { attributes: { artifactId: string } }).attributes
              .artifactId,
        )
        .sort(),
    ).toEqual(["art_1", "art_2"]);
  });

  test("a mid-loop sendMail failure loses no FilePart: the failed workbench recovers on redelivery, the one that already succeeded is not duplicated", async () => {
    const sentMail: { workbenchId: string }[] = [];
    let sendCalls = 0;
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
          workbenchRow("ins_workbench2", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sendCalls += 1;
          if (sendCalls === 2) throw new Error("simulated sendMail failure");
          sentMail.push({ workbenchId: input.workbenchId });
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
    });
    const turn = {
      turnId: "turn_partial_2",
      errors: [],
      toolCalls: [
        {
          isError: false,
          result: JSON.stringify({
            id: "art_1",
            version: 1,
            title: "Notes",
            kind: "text",
            persisted: true,
          }),
        },
      ],
    };

    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One workbench got its FilePart; the other's send threw, releasing
    // its claim.
    expect(sentMail).toHaveLength(1);

    // Redelivery: the workbench that already succeeded is not resent; the
    // one whose send failed is retried and this time succeeds.
    handler("run_1@ten1.workbench.test", turn);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(2);
    expect(sentMail.map((m) => m.workbenchId).sort()).toEqual([
      "ins_workbench1",
      "ins_workbench2",
    ]);
  });
});

// CL-6092: a finalized turn's classified inference failure — never any
// other error — reported to `providerHealth` when exactly one provider
// is connected.
describe("createArtifactDeliveryHandler provider health signal (CL-6092)", () => {
  function baseDeps(overrides?: {
    providerHealth?: { reportInferenceFailure: (args: unknown) => void };
    listConnectedProviders?: (tenantId: string) => Promise<readonly string[]>;
  }) {
    return {
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events: createSidecarEmitter(),
      claims: fakeClaims(),
      ...overrides,
    };
  }

  test("reports a credential_failure error when exactly one provider is connected", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "credential_failure", message: "bad api key" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reports the classified category, never the turn's own error message
    // (CL-6092) — a provider's runtime error text is never stored.
    expect(reported).toEqual([
      {
        tenantId: "ten_1",
        provider: "anthropic",
        category: "credential_failure",
      },
    ]);
  });

  test("reports a quota_exhausted error the same way", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["openai"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "quota_exhausted", message: "quota exhausted" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(1);
  });

  test("does not report an ordinary (non-classified) inference error", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "retryable", message: "temporary blip" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(0);
  });

  test("does not report when the turn has no errors at all", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(0);
  });

  test("never guesses a provider when more than one is connected", async () => {
    const reported: unknown[] = [];
    const handler = createArtifactDeliveryHandler(
      baseDeps({
        providerHealth: {
          reportInferenceFailure: (args) => reported.push(args),
        },
        listConnectedProviders: async () => ["anthropic", "openai"],
      }),
    );

    handler("run_1@ten1.workbench.test", {
      turnId: "turn_1",
      toolCalls: [],
      errors: [{ category: "credential_failure", message: "bad api key" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reported).toHaveLength(0);
  });

  test("does nothing when no providerHealth port is configured", async () => {
    const handler = createArtifactDeliveryHandler(
      baseDeps({ listConnectedProviders: async () => ["anthropic"] }),
    );

    expect(() =>
      handler("run_1@ten1.workbench.test", {
        turnId: "turn_1",
        toolCalls: [],
        errors: [{ category: "credential_failure", message: "bad api key" }],
      }),
    ).not.toThrow();
  });
});

describe("createChatOrchestrator daily transcript digest (CL-5852 M3b)", () => {
  test("records at most one memory entry per workbench per day for a connector.reply", async () => {
    const { memory, added } = fakeMemory();
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
      memory,
    });

    const emitReply = (content: string) =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: { type: "connector.reply", data: { content } },
      });

    emitReply("first reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));
    emitReply("second reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      tenantId: "ten_1",
      principalId: "prn_1",
      kind: "transcript-digest",
      content: { text: "first reply of the day" },
      attributes: { workbenchId: "ins_workbench1" },
    });

    orchestrator.dispose();
  });

  test("records nothing when the memory plane is not mounted", async () => {
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    orchestrator.dispose();
  });

  // CL-6039: the digest's once-per-workbench-per-day bound used to be the
  // process-local `ingestedWorkbenchDays` Set documented (before this
  // change) as "resets on restart". Folded into the same durable
  // `claims` store the two posters above use, so — unlike before — a
  // restart no longer risks a second digest entry for a day already
  // ingested.
  test("still records at most one digest entry per workbench per day across a restart-shaped new orchestrator instance", async () => {
    const { memory, added } = fakeMemory();
    const claims = fakeClaims();
    const deps = {
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      approvals: { findByCorrelationId: async () => null },
      claims,
      memory,
    };

    const firstEvents = createSidecarEmitter();
    const firstOrchestrator = createChatOrchestrator({
      ...deps,
      events: firstEvents,
    });
    firstEvents.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "first reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    firstOrchestrator.dispose();

    // A brand-new orchestrator, built fresh the way the hub would after
    // a restart — but backed by the same durable `claims` store, so its
    // own fresh (and here entirely absent) in-process state can't
    // re-ingest the day's digest.
    const secondEvents = createSidecarEmitter();
    const secondOrchestrator = createChatOrchestrator({
      ...deps,
      events: secondEvents,
    });
    secondEvents.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "second reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    secondOrchestrator.dispose();

    expect(added).toHaveLength(1);
  });

  // CL-6039 (critique follow-up), the digest's narrower version of the
  // same finding: a workbench-day claim survives a `memory.add` that
  // throws unless the write is explicitly released, which would have
  // left that day's digest permanently un-recordable (claimed, but
  // never written, and no later reply that day can win the same claim).
  test("a memory.add failure releases the workbench-day claim, so the next reply that day still records a digest entry", async () => {
    let addCalls = 0;
    const added: unknown[] = [];
    const memory = {
      async add(params: unknown) {
        addCalls += 1;
        if (addCalls === 1) throw new Error("simulated memory.add failure");
        added.push(params);
        return { documentId: "doc_1", versionId: "ver_1" };
      },
    };
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({
        id: "ins_echo1",
        tenantId: "ten_1",
        principalId: "prn_1",
      }) as never,
      store: {
        listWorkbenchSettings: async () => [
          workbenchRow("ins_workbench1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async () => ({
          id: "mail_1",
          createdAt: new Date().toISOString(),
        }),
      },
      events,
      claims: fakeClaims(),
      approvals: { findByCorrelationId: async () => null },
      memory,
    });

    const emitReply = (content: string) =>
      events.emit("agent.event", {
        agentAddress: "ins_echo1@ten1.workbench.test",
        sessionId: "ses_1",
        event: { type: "connector.reply", data: { content } },
      });

    emitReply("first reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The first attempt failed, and nothing was recorded — but this
    // must not be permanent: the claim was released on failure.
    expect(added).toHaveLength(0);

    emitReply("second reply of the day");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      content: { text: "second reply of the day" },
    });

    orchestrator.dispose();
  });
});
