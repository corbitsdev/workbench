import { describe, expect, test } from "bun:test";
import {
  createInMemoryAgentTurnStore,
  AGENT_TURN_STALE_MS,
} from "../src/agent-turns";
import { createInMemoryRoomMessageStore } from "../src/room-messages";
import { listWorkbenchReplyActivity } from "../src/workbench-reply-activity";
import { createChatRoutes } from "../src/routes";
import { buildDeps, createWorkbench, mountAs, TENANT } from "./test-support";

function fixture() {
  let now = Date.now();
  const agentTurns = createInMemoryAgentTurnStore({ now: () => now });
  const roomMessages = createInMemoryRoomMessageStore();
  const readCursors = new Map<string, string>();
  const start = {
    tenantId: TENANT.id,
    workbenchId: "wb_1",
    agentAddress: "agent@acme.example",
    requestMessageIds: ["request_1"],
  };
  const activity = () =>
    listWorkbenchReplyActivity({
      tenantId: TENANT.id,
      workbenchIds: ["wb_1"],
      readCursors,
      agentTurns,
      roomMessages,
    });
  async function reply(
    overrides: {
      senderPrincipalId?: string;
      workbenchId?: string;
      tenantId?: string;
      address?: string;
    } = {},
  ) {
    return roomMessages.insertMessage({
      tenantId: overrides.tenantId ?? TENANT.id,
      workbenchId: overrides.workbenchId ?? "wb_1",
      id: "reply_1",
      sender: {
        name: "Myra",
        address: overrides.address ?? start.agentAddress,
      },
      parts: [{ kind: "text", text: "Here is the revised draft." }],
      ...(overrides.senderPrincipalId !== undefined
        ? { senderPrincipalId: overrides.senderPrincipalId }
        : {}),
    });
  }
  return {
    agentTurns,
    roomMessages,
    start,
    readCursors,
    activity,
    reply,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("sidebar reply activity", () => {
  test("working becomes reply ready only when its actual reply exists, then clears at the read cursor", async () => {
    const f = fixture();
    expect((await f.activity()).get("wb_1")).toBe("idle");
    const turn = await f.agentTurns.startTurn(f.start);
    expect((await f.activity()).get("wb_1")).toBe("working");
    await f.agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: turn.id,
      status: "completed",
      replyMessageId: "reply_1",
    });
    expect((await f.activity()).get("wb_1")).toBe("idle");
    const reply = await f.reply();
    expect((await f.activity()).get("wb_1")).toBe("reply-ready");
    f.readCursors.set("wb_1", reply.createdAt);
    expect((await f.activity()).get("wb_1")).toBe("idle");
  });

  for (const status of ["failed", "cancelled"] as const) {
    test(`a newer ${status} turn suppresses an older unread completion`, async () => {
      const f = fixture();
      const first = await f.agentTurns.startTurn(f.start);
      await f.reply();
      await f.agentTurns.finishTurn({
        tenantId: TENANT.id,
        turnId: first.id,
        status: "completed",
        replyMessageId: "reply_1",
      });
      const second = await f.agentTurns.startTurn(f.start);
      expect((await f.activity()).get("wb_1")).toBe("working");
      await f.agentTurns.finishTurn({
        tenantId: TENANT.id,
        turnId: second.id,
        status,
      });
      expect((await f.activity()).get("wb_1")).toBe("idle");
    });
  }

  test("an older running agent takes precedence over a newer completed agent", async () => {
    const f = fixture();
    await f.agentTurns.startTurn({
      ...f.start,
      agentAddress: "other@acme.example",
    });
    f.advance(1);
    const turn = await f.agentTurns.startTurn(f.start);
    await f.reply();
    await f.agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: turn.id,
      status: "completed",
      replyMessageId: "reply_1",
    });
    expect((await f.activity()).get("wb_1")).toBe("working");
  });

  test("stale, other-tenant and unlisted running turns cannot keep the orbit active", async () => {
    const f = fixture();
    await f.agentTurns.startTurn(f.start);
    f.advance(AGENT_TURN_STALE_MS + 1);
    await f.agentTurns.startTurn({ ...f.start, tenantId: "other" });
    await f.agentTurns.startTurn({ ...f.start, workbenchId: "other" });
    expect((await f.activity()).get("wb_1")).toBe("idle");
  });

  for (const invalid of [
    { senderPrincipalId: "human" },
    { address: "system" },
    { workbenchId: "other" },
    { tenantId: "other" },
  ]) {
    test(`never treats an unrelated reply as completion: ${JSON.stringify(invalid)}`, async () => {
      const f = fixture();
      const turn = await f.agentTurns.startTurn(f.start);
      await f.reply(invalid);
      await f.agentTurns.finishTurn({
        tenantId: TENANT.id,
        turnId: turn.id,
        status: "completed",
        replyMessageId: "reply_1",
      });
      expect((await f.activity()).get("wb_1")).toBe("idle");
    });
  }

  test("ordinary unread messages without an agent turn have no completion indicator", async () => {
    const f = fixture();
    await f.reply({ senderPrincipalId: "human" });
    expect((await f.activity()).get("wb_1")).toBe("idle");
  });

  test("the list route projects activity for the caller and clears it after reading", async () => {
    const f = fixture();
    const deps = buildDeps({
      agentTurns: f.agentTurns,
      roomMessages: f.roomMessages,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Myra",
    });
    const turn = await f.agentTurns.startTurn({
      ...f.start,
      workbenchId: workbench.id,
    });
    const readList = async () =>
      (await app.request("/workbenches?kind=workbench")).json();
    expect(await readList()).toEqual({
      items: [
        expect.objectContaining({ id: workbench.id, activity: "working" }),
      ],
    });
    const reply = await f.reply({ workbenchId: workbench.id });
    await f.agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: turn.id,
      status: "completed",
      replyMessageId: reply.id,
    });
    expect(await readList()).toEqual({
      items: [
        expect.objectContaining({
          activity: "reply-ready",
          preview: "Here is the revised draft.",
        }),
      ],
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/read-state`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          lastSeenCreatedAt: reply.createdAt,
          lastSeenId: reply.id,
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(await readList()).toEqual({
      items: [expect.objectContaining({ activity: "idle" })],
    });
  });
});
