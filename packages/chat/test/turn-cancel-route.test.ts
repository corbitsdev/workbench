// CL-7201: the HTTP surface for cancelling a workbench's in-flight
// turn(s). `turn-cancellation-dispatch.test.ts` exercises
// `cancelWorkbenchTurn`'s own logic directly; this file proves the route
// wires it up correctly — grant enforcement, 404 on an unknown
// workbench, and the shape of the response.
import { describe, expect, test } from "bun:test";

import { createInMemoryAgentTurnStore } from "../src/agent-turns";
import { createChatRoutes } from "../src/routes";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
} from "./test-support";

describe("POST /workbenches/:id/turns/cancel (CL-7201)", () => {
  test("cancels a stuck turn and clears it via the response body", async () => {
    const platform = fakePlatform({
      invitable: [{ id: "wfd_echo", name: "echo" }],
    });
    platform.sendMail = () => new Promise<never>(() => {});
    const agentTurns = createInMemoryAgentTurnStore();
    const deps = buildDeps({
      platform,
      agentTurns,
      turnDispatchTimeoutMs: 60_000,
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    void app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "hello" }] }),
    });
    await Bun.sleep(5);

    const response = await app.request(
      `/workbenches/${workbench.id}/turns/cancel`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ cancelledCount: 1 });
  });

  test("404s for a workbench that doesn't exist", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(
      "/workbenches/run_does_not_exist/turns/cancel",
      { method: "POST" },
    );

    expect(response.status).toBe(404);
  });

  test("denies the request when the write grant is refused", async () => {
    const deps = buildDeps({
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/workbenches/run_1/turns/cancel", {
      method: "POST",
    });

    expect(response.status).toBe(403);
  });
});
