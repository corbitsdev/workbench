// Settings-vocabulary behavior exercised through the HTTP surface:
// `chat/contextWindow` reading/clamping (`contextWindowOf`) and PATCH
// validation (`validateSettingsPatch`). Split out of `routes.test.ts`
// alongside `./workbench-settings.ts` itself.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { decodeParts } from "../src/codec";
import {
  benchContextWindowOf,
  resolveContextWindow,
} from "../src/workbench-settings";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  sendText,
  settleFanout,
  TENANT,
  timelineEvents,
  timelineOf,
} from "./test-support";

describe("chat/contextWindow", () => {
  test("a window of 2 keeps only the last 2 prior messages in the block", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 2 }),
    });

    await sendText(app, workbench.id, "one");
    await sendText(app, workbench.id, "two");
    await sendText(app, workbench.id, "three");
    await sendText(app, workbench.id, "hi @ins_echo1");

    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    expect(contextText).not.toContain("user: one");
    expect(contextText).toContain("user: two");
    expect(contextText).toContain("user: three");
  });

  test("a window of 0 disables the context block entirely", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 0 }),
    });

    await sendText(app, workbench.id, "one");
    await sendText(app, workbench.id, "hi @ins_echo1");

    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content.content).toBe("hi @ins_echo1");
    // The fan-out copy carries the timeline row's own RFC 5322
    // Message-ID (CL-7104), never a reply-to workbench id.
    expect(copy?.content.messageId).toMatch(/^<msg_[0-9a-f]+@acme\.example>$/);
    expect(copy?.content.inReplyTo).toBeUndefined();
  });

  test("an absent setting falls back to the default of 20", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    for (let i = 0; i < 20; i++) {
      await sendText(app, workbench.id, `msg-${i}`);
    }
    await sendText(app, workbench.id, "hi @ins_echo1");

    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    expect(contextText).toContain("user: msg-0");
    expect(contextText).toContain("user: msg-19");
  });

  test("an invalid value (negative or non-numeric) falls back to the default", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": -3 }),
    });

    for (let i = 0; i < 21; i++) {
      await sendText(app, workbench.id, `msg-${i}`);
    }
    await sendText(app, workbench.id, "hi @ins_echo1");

    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    // Default window is 20: the oldest of the 21 prior messages (msg-0)
    // falls outside it.
    expect(contextText).not.toContain("user: msg-0\n");
    expect(contextText).toContain("user: msg-1");
    expect(contextText).toContain("user: msg-20");
  });

  test("an oversized value clamps to the maximum of 200", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 10_000 }),
    });

    for (let i = 0; i < 25; i++) {
      await sendText(app, workbench.id, `msg-${i}`);
    }
    await sendText(app, workbench.id, "hi @ins_echo1");

    await settleFanout();

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    // Clamped to 200, well above the 25 available, so all 25 survive.
    expect(contextText).toContain("user: msg-0");
    expect(contextText).toContain("user: msg-24");
  });

  test("chat/contextWindow round-trips through PATCH /workbenches/:id/settings", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/contextWindow": 5 }),
      },
    );
    expect(response.status).toBe(200);

    const stored = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(stored?.settings["chat/contextWindow"]).toBe(5);
  });

  test("rejects a non-numeric chat/contextWindow value", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/contextWindow": "lots" }),
      },
    );
    expect(response.status).toBe(400);
  });
});

describe("resolveContextWindow", () => {
  test("an absent chat/contextWindow inherits the bench default", () => {
    expect(resolveContextWindow({}, 30)).toEqual({
      value: 30,
      source: "inherit",
    });
  });

  test("a null chat/contextWindow inherits the bench default", () => {
    expect(resolveContextWindow({ "chat/contextWindow": null }, 30)).toEqual({
      value: 30,
      source: "inherit",
    });
  });

  test("an explicit number overrides the bench default", () => {
    expect(resolveContextWindow({ "chat/contextWindow": 5 }, 30)).toEqual({
      value: 5,
      source: "override",
    });
  });

  test("an invalid override (negative or non-numeric) inherits rather than corrupting the effective value", () => {
    expect(resolveContextWindow({ "chat/contextWindow": -3 }, 30)).toEqual({
      value: 30,
      source: "inherit",
    });
    expect(resolveContextWindow({ "chat/contextWindow": "lots" }, 30)).toEqual({
      value: 30,
      source: "inherit",
    });
  });

  test("an oversized override clamps to the maximum, independent of the bench default", () => {
    expect(resolveContextWindow({ "chat/contextWindow": 10_000 }, 30)).toEqual({
      value: 200,
      source: "override",
    });
  });

  test("an oversized bench default clamps too, when inherited", () => {
    expect(resolveContextWindow({}, 10_000)).toEqual({
      value: 200,
      source: "inherit",
    });
  });

  test("throws loudly on an invalid bench default rather than silently coercing it", () => {
    expect(() => resolveContextWindow({}, -1)).toThrow();
    expect(() => resolveContextWindow({}, 1.5)).toThrow();
  });
});

describe("benchContextWindowOf", () => {
  test("defaults to 20 when the bench has set nothing", () => {
    expect(benchContextWindowOf({})).toBe(20);
  });

  test("reads a bench's own set default", () => {
    expect(benchContextWindowOf({ "chat/contextWindow": 50 })).toBe(50);
  });

  test("falls back to the default on an invalid value", () => {
    expect(benchContextWindowOf({ "chat/contextWindow": -5 })).toBe(20);
  });
});

describe("PATCH /workbenches/:id/settings", () => {
  test("validates chat/* strictly, passes foreign namespaces opaquely, and posts the change onto the timeline", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "chat/pinned": false,
          "acme-widget/color": "blue",
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pinned: boolean;
      settings: Record<string, unknown>;
    };
    expect(body.pinned).toBe(false);
    expect(body.settings["acme-widget/color"]).toBe("blue");

    // What changed is a fact about the room, so it is recorded on the
    // room's own timeline rather than mailed anywhere.
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(0);
    const timeline = await timelineOf(deps, workbench.id);
    expect(timelineEvents(timeline, "workbench.settings-changed")).toHaveLength(
      1,
    );
    expect(timeline[0]?.senderPrincipalId).toBe("prn_alice");
  });

  test("rejects an unknown chat/* key strictly", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/nonexistent-field": true }),
      },
    );

    expect(response.status).toBe(400);
  });

  test("rejects a wrongly typed chat/* value", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/pinned": "not-a-boolean" }),
      },
    );

    expect(response.status).toBe(400);
  });

  test("refuses to PATCH chat/participants on a kind: chat", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "chat/participants": [
            { address: "ins_extra@acme.example", handle: "extra" },
          ],
        }),
      },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("kind_is_chat");
  });

  test("chat/purpose round-trips through PATCH /workbenches/:id/settings", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/purpose": "Launch planning" }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      settings: Record<string, unknown>;
    };
    expect(body.settings["chat/purpose"]).toBe("Launch planning");

    const stored = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(stored?.settings["chat/purpose"]).toBe("Launch planning");
  });

  test("rejects a non-string chat/purpose value", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/purpose": 123 }),
      },
    );
    expect(response.status).toBe(400);
  });

  test("a GET/PATCH response reports the effective contextWindow as inherited by default", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/settings`);
    const body = (await response.json()) as {
      contextWindow: { value: number; source: string };
    };
    expect(body.contextWindow).toEqual({ value: 20, source: "inherit" });
  });

  test("PATCHing an explicit chat/contextWindow reports it as overridden", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/contextWindow": 7 }),
      },
    );
    const body = (await response.json()) as {
      contextWindow: { value: number; source: string };
    };
    expect(body.contextWindow).toEqual({ value: 7, source: "override" });
  });

  test("PATCHing chat/contextWindow to null clears an override back to inherit, distinct from omitting the key", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 7 }),
    });

    const omittedResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/pinned": true }),
      },
    );
    const omittedBody = (await omittedResponse.json()) as {
      contextWindow: { value: number; source: string };
    };
    expect(omittedBody.contextWindow).toEqual({ value: 7, source: "override" });

    const clearedResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/contextWindow": null }),
      },
    );
    const clearedBody = (await clearedResponse.json()) as {
      contextWindow: { value: number; source: string };
      settings: Record<string, unknown>;
    };
    expect(clearedBody.contextWindow).toEqual({ value: 20, source: "inherit" });
    expect(clearedBody.settings["chat/contextWindow"]).toBeNull();
  });

  test("concurrent PATCH of chat/participants and chat/pinned both land", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const before = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    const existingParticipants = before?.settings["chat/participants"];
    const extra = {
      address: "ins_extra@acme.example",
      handle: "extra",
    };

    const [pinnedResponse, participantsResponse] = await Promise.all([
      app.request(`/workbenches/${workbench.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/pinned": true }),
      }),
      app.request(`/workbenches/${workbench.id}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          "chat/participants": [
            ...(Array.isArray(existingParticipants)
              ? existingParticipants
              : []),
            extra,
          ],
        }),
      }),
    ]);

    expect(pinnedResponse.status).toBe(200);
    expect(participantsResponse.status).toBe(200);

    const stored = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(stored?.settings["chat/pinned"]).toBe(true);
    const participants = stored?.settings["chat/participants"];
    expect(Array.isArray(participants)).toBe(true);
    expect(participants).toContainEqual(extra);
  });
});

describe("GET/PATCH /bench/settings", () => {
  test("defaults to the code-level default when the bench has set nothing", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/bench/settings");
    const body = (await response.json()) as { contextWindow: number };
    expect(body.contextWindow).toBe(20);
  });

  test("PATCH sets the bench default, which every inheriting workbench then reflects", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const patchResponse = await app.request("/bench/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 40 }),
    });
    expect(patchResponse.status).toBe(200);
    const patchBody = (await patchResponse.json()) as { contextWindow: number };
    expect(patchBody.contextWindow).toBe(40);

    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });
    const workbenchResponse = await app.request(
      `/workbenches/${workbench.id}/settings`,
    );
    const workbenchBody = (await workbenchResponse.json()) as {
      contextWindow: { value: number; source: string };
    };
    expect(workbenchBody.contextWindow).toEqual({
      value: 40,
      source: "inherit",
    });
  });

  test("rejects a null bench default — there is nothing beneath it to inherit from", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request("/bench/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": null }),
    });
    expect(response.status).toBe(400);
  });
});
