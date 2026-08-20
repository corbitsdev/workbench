import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "./agent-turns";

const BASE = {
  tenantId: "ten_1",
  workbenchId: "wb_1",
  agentAddress: "ins_echo1@acme.example",
  requestMessageIds: ["msg_1"],
};

describe("createInMemoryAgentTurnStore", () => {
  test("a turn opens running, with the child run id its occurrence will use", async () => {
    const store = createInMemoryAgentTurnStore();
    const turn = await store.startTurn(BASE);

    expect(turn.status).toBe("running");
    expect(turn.occurrence).toBe(0);
    expect(turn.childRunId).toBe("turn__0");
    expect(turn.replyMessageId).toBeNull();
    expect(turn.endedAt).toBeNull();
    expect(turn.requestMessageIds).toEqual(["msg_1"]);
  });

  test("occurrences advance per (workbench, agent), never across them", async () => {
    const store = createInMemoryAgentTurnStore();
    const first = await store.startTurn(BASE);
    const second = await store.startTurn(BASE);
    const otherAgent = await store.startTurn({
      ...BASE,
      agentAddress: "ins_echo2@acme.example",
    });
    const otherWorkbench = await store.startTurn({
      ...BASE,
      workbenchId: "wb_2",
    });

    expect([first.childRunId, second.childRunId]).toEqual([
      "turn__0",
      "turn__1",
    ]);
    expect(otherAgent.childRunId).toBe("turn__0");
    expect(otherWorkbench.childRunId).toBe("turn__0");
  });

  test("finishing records the outcome, the reply, and the section run", async () => {
    const store = createInMemoryAgentTurnStore();
    const opened = await store.startTurn(BASE);

    const finished = await store.finishTurn({
      tenantId: BASE.tenantId,
      turnId: opened.id,
      status: "completed",
      sectionRunId: "wfr_section1",
      replyMessageId: "msg_reply",
    });

    expect(finished?.status).toBe("completed");
    expect(finished?.sectionRunId).toBe("wfr_section1");
    expect(finished?.replyMessageId).toBe("msg_reply");
    expect(finished?.endedAt).not.toBeNull();
    expect(finished?.childRunId).toBe(opened.childRunId);
  });

  test("a failed turn is recorded as failed, with its reason", async () => {
    const store = createInMemoryAgentTurnStore();
    const opened = await store.startTurn(BASE);

    const finished = await store.finishTurn({
      tenantId: BASE.tenantId,
      turnId: opened.id,
      status: "failed",
      error: "the agent never answered",
    });

    expect(finished?.status).toBe("failed");
    expect(finished?.error).toBe("the agent never answered");
  });

  test("a turn is never readable or writable from another tenant", async () => {
    const store = createInMemoryAgentTurnStore();
    const opened = await store.startTurn(BASE);

    expect(
      await store.getTurn({ tenantId: "ten_other", turnId: opened.id }),
    ).toBeUndefined();
    expect(
      await store.finishTurn({
        tenantId: "ten_other",
        turnId: opened.id,
        status: "completed",
      }),
    ).toBeUndefined();
  });

  test("listing is newest first and scoped to its workbench", async () => {
    const store = createInMemoryAgentTurnStore();
    const first = await store.startTurn(BASE);
    await Bun.sleep(2);
    const second = await store.startTurn(BASE);
    await store.startTurn({ ...BASE, workbenchId: "wb_2" });

    const listed = await store.listTurns({
      tenantId: BASE.tenantId,
      workbenchId: BASE.workbenchId,
    });
    expect(listed.map((turn) => turn.id)).toEqual([second.id, first.id]);
  });
});
