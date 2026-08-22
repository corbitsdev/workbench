// The swap CL-6329 makes, as a test: asking an agent for a turn opens a
// row on the turn projection before the execution plane is touched, so
// every occurrence is named (`turn__<n>`) and traceable from the room's
// own rows — and a burst of messages produces turns in arrival order
// rather than a race.
import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { createChatRoutes } from "../src/routes";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  sendText,
  settleFanout,
  TENANT,
} from "./test-support";

async function roomWithAgent(
  overrides: Parameters<typeof buildDeps>[0] = {},
): Promise<{
  app: ReturnType<typeof createChatRoutes>;
  deps: ReturnType<typeof buildDeps>;
  workbenchId: string;
  agentTurns: ReturnType<typeof createInMemoryAgentTurnStore>;
}> {
  const agentTurns = createInMemoryAgentTurnStore();
  const deps = buildDeps({ agentTurns, ...overrides });
  const app = mountAs(createChatRoutes(deps), "prn_ada");
  const { body } = await createWorkbench(app, {
    kind: "chat",
    definitionId: "wfd_echo",
  });
  await settleFanout();
  return { app, deps, workbenchId: body.id, agentTurns };
}

describe("dispatchTurn's turn projection", () => {
  test("a dispatched message opens one running turn per agent asked", async () => {
    const { app, workbenchId, agentTurns } = await roomWithAgent({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "echo" }] }),
    });

    await sendText(app, workbenchId, "hello");

    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      childRunId: "turn__0",
      occurrence: 0,
      status: "running",
      replyMessageId: null,
    });
    expect(turns[0]?.requestMessageIds).toHaveLength(1);
  });

  // CL-6670: dispatch now waits for an agent's own prior turn to close
  // (`AgentTurnStore.waitUntilFree`) before opening the next occurrence
  // for it, so this burst only produces its second and third turns as
  // each prior one is finished — never three simultaneously-`running`
  // rows `findRunningTurn` could only guess between.
  test("three messages in a row become three turns in arrival order", async () => {
    const { app, workbenchId, agentTurns } = await roomWithAgent({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "echo" }] }),
    });

    await sendText(app, workbenchId, "one");
    const [firstTurn] = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    await agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: firstTurn?.id ?? "",
      status: "completed",
    });

    await sendText(app, workbenchId, "two");
    const [secondTurn] = (
      await agentTurns.listTurns({ tenantId: TENANT.id, workbenchId })
    ).filter((turn) => turn.id !== firstTurn?.id);
    await agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: secondTurn?.id ?? "",
      status: "completed",
    });

    await sendText(app, workbenchId, "three");

    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    const occurrences = turns.map((turn) => turn.occurrence).sort();
    expect(occurrences).toEqual([0, 1, 2]);
    expect(turns.map((turn) => turn.childRunId).sort()).toEqual([
      "turn__0",
      "turn__1",
      "turn__2",
    ]);
  });

  test("an unreachable agent closes its turn failed rather than leaving it open", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    let refuse = false;
    const refusing = {
      ...platform,
      sendMail: async (input: Parameters<typeof platform.sendMail>[0]) => {
        if (refuse) throw new Error("the agent is unreachable");
        return platform.sendMail(input);
      },
    };
    const { app, workbenchId, agentTurns } = await roomWithAgent({
      platform: refusing,
    });

    refuse = true;
    await sendText(app, workbenchId, "hello");

    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      status: "failed",
      error: "the agent is unreachable",
    });
    expect(turns[0]?.endedAt).not.toBeNull();
  });
});

// CL-6670: overlapping turns in one room must never silently drop a
// reply. Reproduced live as: @agent-A a question, then — while A is
// still generating — @agent-B a different question; A's reply never
// landed, with no error and no notice anywhere.
describe("overlapping turns across agents and messages (CL-6670)", () => {
  test("a second agent's turn starts immediately, even while the first agent's turn is still open (never replied)", async () => {
    const platform = fakePlatform();
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({ agentTurns, platform });
    const app = mountAs(createChatRoutes(deps), "prn_ada");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "review",
      participants: ["ins_a1@acme.example", "ins_b1@acme.example"],
    });

    // @A's mail hands off normally (this is not about a slow dispatch
    // call, `turn-dispatch-deadline.test.ts` already covers that) — its
    // turn simply never closes, standing in for "A is still generating
    // its reply" exactly as CL-6670 was reproduced live.
    await sendText(app, workbench.id, "hi @ins_a1");
    const aTurn = await agentTurns.findRunningTurn({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
      agentAddress: "ins_a1@acme.example",
    });
    expect(aTurn?.status).toBe("running");

    // A different agent, mentioned next while A's turn is still open:
    // must dispatch and open its own running turn without ever waiting
    // on A's.
    await sendText(app, workbench.id, "hi @ins_b1");

    const bTurn = await agentTurns.findRunningTurn({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
      agentAddress: "ins_b1@acme.example",
    });
    expect(bTurn?.childRunId).toBe("turn__0");
    expect(
      platform.sentMail.some((mail) => mail.workbenchId === "ins_b1"),
    ).toBe(true);

    // A's own turn was never touched by B's arrival — still open,
    // waiting for A's real reply, exactly as it was before B's message.
    const aTurnAfter = await agentTurns.findRunningTurn({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
      agentAddress: "ins_a1@acme.example",
    });
    expect(aTurnAfter?.id).toBe(aTurn?.id);
    expect(aTurnAfter?.status).toBe("running");
  });

  test("a second message to the SAME agent waits for its first turn to close, rather than opening a second running row", async () => {
    const { app, workbenchId, agentTurns, deps } = await roomWithAgent({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "echo" }] }),
    });

    await sendText(app, workbenchId, "one");
    const [firstTurn] = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    expect(firstTurn?.status).toBe("running");

    // Sent while the agent is still "generating" its first reply — must
    // queue rather than mint a second simultaneously-running turn.
    let secondSendSettled = false;
    const secondSend = sendText(app, workbenchId, "two").then(() => {
      secondSendSettled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(secondSendSettled).toBe(false);
    const stillOnlyOne = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    expect(stillOnlyOne).toHaveLength(1);
    expect(
      (deps.platform as ReturnType<typeof fakePlatform>).sentMail,
    ).toHaveLength(1);

    // The agent's real reply lands — the first turn closes...
    await agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: firstTurn?.id ?? "",
      status: "completed",
      replyMessageId: "msg_reply1",
    });
    await secondSend;
    expect(secondSendSettled).toBe(true);

    // ...and only THEN does the second message open its own turn: two
    // turns total, never two running at once.
    const turns = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    expect(turns.map((turn) => turn.childRunId).sort()).toEqual([
      "turn__0",
      "turn__1",
    ]);
    expect(
      (deps.platform as ReturnType<typeof fakePlatform>).sentMail,
    ).toHaveLength(2);
  });
});

describe("the turns routes", () => {
  test("serve the projection back, newest first, and 404 an unknown turn", async () => {
    const { app, workbenchId, agentTurns } = await roomWithAgent({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "echo" }] }),
    });
    await sendText(app, workbenchId, "hello");

    const listed = await app.request(`/workbenches/${workbenchId}/turns`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { items: { id: string }[] };
    expect(body.items).toHaveLength(1);

    const [only] = await agentTurns.listTurns({
      tenantId: TENANT.id,
      workbenchId,
    });
    const one = await app.request(
      `/workbenches/${workbenchId}/turns/${only?.id ?? ""}`,
    );
    expect(one.status).toBe(200);
    expect(await one.json()).toMatchObject({ childRunId: "turn__0" });

    const missing = await app.request(
      `/workbenches/${workbenchId}/turns/turn_nope`,
    );
    expect(missing.status).toBe(404);
  });
});
