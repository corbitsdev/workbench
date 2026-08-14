// Proves the orchestrator's own wiring: a `connector.reply` on the
// shared `agent.event` stream resolves the replying address to its
// folded run, finds every channel whose participants carry that
// address (defensively — more than one, if the store ever shows it),
// and posts the reply into each via `platform.sendMail` with
// `fromChannelId` set to the agent's own run id. Non-reply events are
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
import type { ChannelSettingsRow } from "../src/store";

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
function createFakeDb(run?: { id: string; tenantId: string }) {
  return {
    query: {
      workflowRun: {
        findFirst: async () => run,
      },
    },
  };
}

function channelRow(
  channelId: string,
  participantAddresses: string[],
): ChannelSettingsRow {
  return {
    tenantId: "ten_1",
    channelId,
    settings: {
      "chat/kind": "channel",
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
  test("posts a connector.reply into the member channel resolved from the store", async () => {
    const sentMail: {
      tenantId: string;
      channelId: string;
      content: unknown;
      fromChannelId?: string;
    }[] = [];
    const listChannelSettingsCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async (tenantId) => {
          listChannelSettingsCalls.push(tenantId);
          return [
            channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
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
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hello back" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(listChannelSettingsCalls).toEqual(["ten_1"]);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0]).toMatchObject({
      tenantId: "ten_1",
      channelId: "ins_channel1",
      fromChannelId: "ins_echo1",
    });

    orchestrator.dispose();
  });

  test("posts into every channel when the store shows the address in more than one", async () => {
    const sentMail: { channelId: string }[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
          channelRow("ins_channel2", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push({ channelId: input.channelId });
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
      approvals: { findByCorrelationId: async () => null },
    });

    events.emit("agent.event", {
      agentAddress: "ins_echo1@ten1.workbench.test",
      sessionId: "ses_1",
      event: { type: "connector.reply", data: { content: "hi" } },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail.map((m) => m.channelId).sort()).toEqual([
      "ins_channel1",
      "ins_channel2",
    ]);

    orchestrator.dispose();
  });

  test("ignores non-reply events for posting but still bumps activity", async () => {
    const sentMail: unknown[] = [];
    const recordActivityCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: { listChannelSettings: async () => [] },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
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
      store: { listChannelSettings: async () => [] },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
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
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
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
      channelId: string;
      content: unknown;
      fromChannelId?: string;
    }[] = [];
    const findByCorrelationIdCalls: string[] = [];
    const events = createSidecarEmitter();
    const orchestrator = createChatOrchestrator({
      db: createFakeDb({ id: "ins_echo1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push(input as never);
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events,
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
      channelId: "ins_channel1",
      fromChannelId: "ins_echo1",
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
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
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
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
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
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["ins_echo1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events,
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
  test("posts a FilePart into every member channel for a finalized turn naming a persisted artifact", async () => {
    const sentMail: { channelId: string; content: unknown }[] = [];
    const handler = createArtifactDeliveryHandler({
      approvals: { findByCorrelationId: async () => null },
      db: createFakeDb({ id: "run_1", tenantId: "ten_1" }) as never,
      store: {
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: {
        sendMail: async (input) => {
          sentMail.push({ channelId: input.channelId, content: input.content });
          return { id: "mail_1", createdAt: new Date().toISOString() };
        },
      },
      events: createSidecarEmitter(),
    });

    handler("run_1@ten1.workbench.test", {
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
    expect(sentMail[0]?.channelId).toBe("ins_channel1");
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
        listChannelSettings: async () => [
          channelRow("ins_channel1", ["run_1@ten1.workbench.test"]),
        ],
      },
      platform: { sendMail: async () => sentMail.push(1) as never },
      events: createSidecarEmitter(),
    });

    handler("run_1@ten1.workbench.test", {
      toolCalls: [{ isError: false, result: "{}" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sentMail).toHaveLength(0);
  });
});
