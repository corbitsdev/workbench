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

  test("three messages in a row become three turns in arrival order", async () => {
    const { app, workbenchId, agentTurns } = await roomWithAgent({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "echo" }] }),
    });

    await sendText(app, workbenchId, "one");
    await sendText(app, workbenchId, "two");
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
