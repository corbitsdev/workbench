import { describe, expect, test } from "bun:test";

import {
  AGENT_TURN_STALE_MS,
  createInMemoryAgentTurnStore,
} from "./agent-turns";

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

  // CL-6451: a dispatch the supervisor failed (or a hub that died
  // mid-turn) never sends the event that closes its row, so a turn
  // still `running` past the occurrence timeout is dead by construction
  // — it fails visibly instead of showing "typing" forever.
  test("a running turn past the stale cutoff reads back failed, never running", async () => {
    let clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    await store.startTurn(BASE);

    clock += AGENT_TURN_STALE_MS + 1;

    expect(await store.findRunningTurn(BASE)).toBeUndefined();
    const listed = await store.listTurns({
      tenantId: BASE.tenantId,
      workbenchId: BASE.workbenchId,
    });
    expect(listed[0]?.status).toBe("failed");
    expect(listed[0]?.error).not.toBeNull();
    expect(listed[0]?.endedAt).not.toBeNull();
  });

  test("a running turn within the stale cutoff stays running", async () => {
    let clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    const opened = await store.startTurn(BASE);

    clock += AGENT_TURN_STALE_MS - 1;

    expect((await store.findRunningTurn(BASE))?.id).toBe(opened.id);
  });

  test("starting a new turn expires a stale predecessor rather than leaving two running", async () => {
    let clock = 1_000;
    const store = createInMemoryAgentTurnStore({ now: () => clock });
    const stale = await store.startTurn(BASE);

    clock += AGENT_TURN_STALE_MS + 1;
    const fresh = await store.startTurn(BASE);

    expect((await store.findRunningTurn(BASE))?.id).toBe(fresh.id);
    expect(
      (await store.getTurn({ tenantId: BASE.tenantId, turnId: stale.id }))
        ?.status,
    ).toBe("failed");
  });

  // CL-6670: `dispatchTurn` awaits this before opening a second occurrence
  // for the same (workbench, agent) — the fix for two messages sent to
  // one agent a few seconds apart each winning a `running` row while the
  // other's reply was still in flight, which left `findRunningTurn`
  // guessing which real reply belonged to which row.
  describe("waitUntilFree (CL-6670)", () => {
    test("resolves immediately when the agent has no running turn", async () => {
      const store = createInMemoryAgentTurnStore();
      // No timeout needed: a hanging promise would fail this test itself.
      await store.waitUntilFree(BASE);
    });

    test("blocks until the running turn finishes, never before", async () => {
      const store = createInMemoryAgentTurnStore();
      const opened = await store.startTurn(BASE);

      let freed = false;
      const waiting = store.waitUntilFree(BASE).then(() => {
        freed = true;
      });

      // Give the pending promise every chance to (wrongly) resolve early.
      await Promise.resolve();
      await Promise.resolve();
      expect(freed).toBe(false);

      await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "completed",
      });
      await waiting;
      expect(freed).toBe(true);
    });

    test("a different agent's wait is never blocked by this one's turn", async () => {
      const store = createInMemoryAgentTurnStore();
      await store.startTurn(BASE);

      // Would hang (and fail the test on timeout) if this incorrectly
      // shared the first agent's gate.
      await store.waitUntilFree({
        ...BASE,
        agentAddress: "ins_other@acme.example",
      });
    });

    test("a failed turn also frees the wait", async () => {
      const store = createInMemoryAgentTurnStore();
      const opened = await store.startTurn(BASE);

      let freed = false;
      const waiting = store.waitUntilFree(BASE).then(() => {
        freed = true;
      });
      await Promise.resolve();
      expect(freed).toBe(false);

      await store.finishTurn({
        tenantId: BASE.tenantId,
        turnId: opened.id,
        status: "failed",
        error: "boom",
      });
      await waiting;
      expect(freed).toBe(true);
    });
  });
});
