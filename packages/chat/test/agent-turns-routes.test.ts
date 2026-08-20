// The turn projection's own read surface (CL-6329): the routes that make
// a reply traceable back to the child run that produced it, plus the
// "no store, no feature" 404 every optional chat store already follows.
import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import type { AgentTurn } from "../src/agent-turns";
import { createChatRoutes } from "../src/routes";
import { buildDeps, createWorkbench, mountAs, TENANT } from "./test-support";

describe("GET /workbenches/:id/turns", () => {
  test("404s when the host injected no turn store", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = (
      await createWorkbench(app, { kind: "workbench", name: "room" })
    ).body.id;

    const res = await app.request(`/workbenches/${workbenchId}/turns`);
    expect(res.status).toBe(404);
  });

  test("serves a workbench's turns newest first, each carrying its child run id", async () => {
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({ agentTurns });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = (
      await createWorkbench(app, { kind: "workbench", name: "room" })
    ).body.id;

    const first = await agentTurns.startTurn({
      tenantId: TENANT.id,
      workbenchId,
      agentAddress: "ins_echo1@acme.example",
      requestMessageIds: ["msg_1"],
    });
    await Bun.sleep(2);
    const second = await agentTurns.startTurn({
      tenantId: TENANT.id,
      workbenchId,
      agentAddress: "ins_echo2@acme.example",
      requestMessageIds: ["msg_1"],
    });

    const res = await app.request(`/workbenches/${workbenchId}/turns`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: AgentTurn[] };
    expect(body.items.map((turn) => turn.id)).toEqual([second.id, first.id]);
    expect(body.items.map((turn) => turn.childRunId)).toEqual([
      "turn__0",
      "turn__0",
    ]);
    expect(body.items.map((turn) => turn.agentAddress)).toEqual([
      "ins_echo2@acme.example",
      "ins_echo1@acme.example",
    ]);
  });
});

describe("GET /workbenches/:id/turns/:turnId", () => {
  test("reads one turn back, including how it ended and what it replied with", async () => {
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({ agentTurns });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = (
      await createWorkbench(app, { kind: "workbench", name: "room" })
    ).body.id;

    const opened = await agentTurns.startTurn({
      tenantId: TENANT.id,
      workbenchId,
      agentAddress: "ins_echo1@acme.example",
      requestMessageIds: ["msg_1"],
    });
    await agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: opened.id,
      status: "completed",
      sectionRunId: "wfr_section1",
      replyMessageId: "msg_reply",
    });

    const res = await app.request(
      `/workbenches/${workbenchId}/turns/${opened.id}`,
    );
    expect(res.status).toBe(200);
    const turn = (await res.json()) as AgentTurn;
    expect(turn.status).toBe("completed");
    expect(turn.childRunId).toBe("turn__0");
    expect(turn.sectionRunId).toBe("wfr_section1");
    expect(turn.replyMessageId).toBe("msg_reply");
  });

  test("a failed turn is readable as failed, with its reason", async () => {
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({ agentTurns });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = (
      await createWorkbench(app, { kind: "workbench", name: "room" })
    ).body.id;

    const opened = await agentTurns.startTurn({
      tenantId: TENANT.id,
      workbenchId,
      agentAddress: "ins_echo1@acme.example",
      requestMessageIds: ["msg_1"],
    });
    await agentTurns.finishTurn({
      tenantId: TENANT.id,
      turnId: opened.id,
      status: "failed",
      error: "the agent never answered",
    });

    const res = await app.request(
      `/workbenches/${workbenchId}/turns/${opened.id}`,
    );
    const turn = (await res.json()) as AgentTurn;
    expect(turn.status).toBe("failed");
    expect(turn.error).toBe("the agent never answered");
  });

  test("a turn belonging to another workbench is not found here", async () => {
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({ agentTurns });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const here = (
      await createWorkbench(app, { kind: "workbench", name: "here" })
    ).body.id;
    const elsewhere = (
      await createWorkbench(app, { kind: "workbench", name: "elsewhere" })
    ).body.id;

    const opened = await agentTurns.startTurn({
      tenantId: TENANT.id,
      workbenchId: elsewhere,
      agentAddress: "ins_echo1@acme.example",
      requestMessageIds: ["msg_1"],
    });

    const res = await app.request(`/workbenches/${here}/turns/${opened.id}`);
    expect(res.status).toBe(404);
  });

  test("an unknown turn id is not found", async () => {
    const deps = buildDeps({ agentTurns: createInMemoryAgentTurnStore() });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const workbenchId = (
      await createWorkbench(app, { kind: "workbench", name: "room" })
    ).body.id;

    const res = await app.request(
      `/workbenches/${workbenchId}/turns/turn_nope`,
    );
    expect(res.status).toBe(404);
  });
});
