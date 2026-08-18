// Fan-out, context-loading, and join/invite behavior — the surface
// `./workbench-service.ts`'s `sendWorkbenchMessage` and `launchAndJoinAgent`
// own — exercised through the HTTP layer. Split out of
// `routes.test.ts` alongside the module itself.
import { describe, expect, test } from "bun:test";
import { createChatRoutes } from "../src/routes";
import { decodeParts } from "../src/codec";
import type { Part } from "../src/parts";
import { createInMemoryWorkbenchTenancyStore } from "../src/workbench-tenancy";
import { AgentUnreachableError } from "../src/platform-port";
import {
  dispatchGreetingKickoff,
  greetingKickoffBrief,
  kickoffDate,
} from "../src/workbench-service";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  TENANT,
} from "./test-support";

describe("dispatchGreetingKickoff (CL-6126)", () => {
  test("sends a kickoff mail straight to the agent's own mailbox, not the chat's", async () => {
    const platform = fakePlatform();

    await dispatchGreetingKickoff(
      { platform },
      {
        tenantId: TENANT.id,
        principalId: "prn_alice",
        workbenchId: "chan_1",
        agentAddress: "ins_agent1@acme.example",
      },
    );

    expect(platform.sentMail).toHaveLength(1);
    const kickoff = platform.sentMail[0];
    expect(kickoff?.workbenchId).toBe("ins_agent1");
    expect(kickoff?.fromWorkbenchId).toBe("chan_1");
    expect(kickoff?.content).toEqual({
      content: greetingKickoffBrief({ openedOn: kickoffDate(new Date()) }),
    });
  });

  test("kickoffDate formats as dd/mm/yyyy", () => {
    expect(kickoffDate(new Date(2026, 7, 17))).toBe("17/08/2026");
    expect(kickoffDate(new Date(2026, 0, 3))).toBe("03/01/2026");
  });

  test("the kickoff brief carries who opened the workbench and what it is called, and asks for a teammate's hello — never a menu", () => {
    const brief = greetingKickoffBrief({
      senderName: "Ada",
      workbenchName: "GTM research",
    });
    expect(brief).toContain("Ada");
    expect(brief).toContain("GTM research");
    expect(brief).toMatch(/teammate/i);
    expect(brief).toMatch(/no menu/i);
    expect(brief).toMatch(/memory/i);
    expect(greetingKickoffBrief({})).not.toContain("undefined");
  });

  test("a distinctive workbench name is framed as a chosen label, never a brief to answer", () => {
    const brief = greetingKickoffBrief({
      senderName: "Ada",
      workbenchName: "Copywriter test",
    });
    expect(brief).toContain('titled "Copywriter test"');
    expect(brief).toMatch(/label the person chose, not a request/i);
    expect(brief).toMatch(
      /never treat it as their brief or answer it as a question/i,
    );
    expect(brief).not.toContain("undefined");
  });

  test.each(["New Workbench", "Untitled", "Session A", "Room 3", "test run"])(
    "a generic workbench name (%s) is omitted from the brief entirely",
    (workbenchName) => {
      const brief = greetingKickoffBrief({ senderName: "Ada", workbenchName });
      expect(brief).not.toContain(workbenchName);
      expect(brief).not.toContain("titled");
      expect(brief).not.toContain("undefined");
    },
  );

  test.each(["run_0123456789abcdef", "wfd_a1b2c3d4e5f6", "ins_agent1"])(
    "an id-shaped workbench name (%s) is omitted from the brief entirely",
    (workbenchName) => {
      const brief = greetingKickoffBrief({ senderName: "Ada", workbenchName });
      expect(brief).not.toContain(workbenchName);
      expect(brief).not.toContain("titled");
      expect(brief).not.toContain("undefined");
    },
  );

  test("an explicit human title is still included alongside a real name", () => {
    const brief = greetingKickoffBrief({
      senderName: "Ada",
      workbenchName: "Myra",
    });
    expect(brief).toContain('titled "Myra"');
  });

  test("an absent workbench name is omitted from the brief entirely", () => {
    const brief = greetingKickoffBrief({ senderName: "Ada" });
    expect(brief).not.toContain("titled");
    expect(brief).not.toContain("undefined");
  });

  test("a direct chat greets as a conversation, never a workbench, and drops any name it was given", () => {
    const brief = greetingKickoffBrief({
      senderName: "alice",
      workbenchName: "Myra",
      isDirectChat: true,
    });
    expect(brief).toContain("direct chat with alice");
    expect(brief).not.toContain("workbench");
    expect(brief).not.toContain("Myra");
    expect(brief).not.toContain("titled");
    expect(brief).toMatch(/ask what they need/i);
  });

  test("a direct chat with no resolved sender name still reads naturally", () => {
    const brief = greetingKickoffBrief({ isDirectChat: true });
    expect(brief).toContain("direct chat with someone");
    expect(brief).not.toContain("undefined");
  });

  test("a group workbench greeting is unaffected by isDirectChat being absent/false", () => {
    const brief = greetingKickoffBrief({
      senderName: "Ada",
      workbenchName: "GTM research",
      isDirectChat: false,
    });
    expect(brief).toContain('titled "GTM research"');
    expect(brief).toMatch(/what they are working on/i);
  });

  test("the brief carries the opening date when given one", () => {
    const brief = greetingKickoffBrief({
      senderName: "Ada",
      openedOn: "17/08/2026",
    });
    expect(brief).toContain("17/08/2026");
    expect(brief).toMatch(/today/i);
  });

  test("an absent opening date is omitted from the brief entirely", () => {
    const brief = greetingKickoffBrief({ senderName: "Ada" });
    expect(brief).not.toMatch(/today/i);
    expect(brief).not.toContain("undefined");
  });

  test("a dispatch failure is swallowed, never thrown", async () => {
    const platform = fakePlatform({
      sendMail: async () => {
        throw new Error("agent unreachable");
      },
    });

    await expect(
      dispatchGreetingKickoff(
        { platform },
        {
          tenantId: TENANT.id,
          principalId: "prn_alice",
          workbenchId: "chan_1",
          agentAddress: "ins_agent1@acme.example",
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("message fan-out", () => {
  test("fan-out copies to mentioned agents are sent from the workbench", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "demo",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "hi @ins_echo1" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(2);
    const copy = platform.sentMail[1];
    expect(copy?.workbenchId).toBe("ins_echo1");
    expect(copy?.fromWorkbenchId).toBe(workbench.id);
  });

  test("a message to a chat delivers to its agent without a mention", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const mailBefore = platform.sentMail.length; // the join event

    const parts: Part[] = [{ kind: "text", text: "hello, no mention here" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    expect(platform.sentMail).toHaveLength(mailBefore + 2); // to the chat, then fanned to the agent
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.workbenchId).toBe("ins_invited1");
    expect(fanned?.fromWorkbenchId).toBe(workbench.id);
  });

  test("a message to a person-DM chat fans out to no one — the other party reads the workbench's own timeline", async () => {
    const deps = buildDeps();
    const tenancy = deps.tenancy as ReturnType<
      typeof createInMemoryWorkbenchTenancyStore
    >;
    tenancy.registerPrincipal(TENANT.id, {
      id: "prn_bob",
      kind: "user",
      status: "active",
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      principalId: "prn_bob",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const mailBefore = platform.sentMail.length; // the join event

    const parts: Part[] = [{ kind: "text", text: "hey Bob" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    expect(platform.sentMail).toHaveLength(mailBefore + 1); // only the send itself, no fan-out copy
  });

  test("a no-mention message in a workbench routes to its host — the first agent participant", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const parts: Part[] = [{ kind: "text", text: "no mention at all" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(2); // to the workbench, then fanned to the host
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.workbenchId).toBe("ins_echo1");
  });

  test("a no-mention message in a multi-agent workbench delivers to the host only, not every agent", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo", name: "Echo" },
          { id: "wfd_second", name: "Second" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example", "ins_echo2@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "no mention at all" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.sentMail).toHaveLength(2); // to the workbench, then fanned to the host only
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.workbenchId).toBe("ins_echo1");
  });

  test("a reply to an agent's message routes to that agent even unmentioned", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_echo", name: "Echo" },
          { id: "wfd_second", name: "Second" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example", "ins_echo2@acme.example"],
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // Simulates the orchestrator's own posted reply — sent from the
    // agent's workbench, no principalId — landing in the workbench's
    // mailbox exactly as `postReply` delivers it.
    const parent = await platform.sendMail({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
      fromWorkbenchId: "ins_echo2",
      content: { content: "here's my answer" },
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "thanks, no mention here" }],
          inReplyToMessageId: parent.id,
        }),
      },
    );

    expect(response.status).toBe(201);
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.workbenchId).toBe("ins_echo2");
  });

  test("a mention fan-out carries the prior workbench conversation, excluding the just-sent message", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "first message" }],
      }),
    });
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "second message" }],
      }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const decoded = decodeParts(copy?.content ?? { content: "" });

    // Exactly ONE text part: the context is merged into the message's
    // text, never sent as a part of its own — a second part makes the
    // copy multipart MIME, which the agent-side mail parser fails on.
    expect(decoded).toHaveLength(1);
    const [merged] = decoded;
    expect(merged?.kind).toBe("text");
    const mergedText = merged?.kind === "text" ? merged.text : "";
    expect(mergedText.split("\n")).toEqual([
      "[Workbench context — the most recent messages in this workbench, oldest " +
        "first. The actual message addressed to you follows after this " +
        "block.]",
      "user: first message",
      "user: second message",
      "",
      "hi @ins_echo1",
    ]);
  });

  test("no prior messages means no context part at all, copy identical to today", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: workbench.id,
    });
  });

  test("a chat's fan-out carries no context block, even with a full history", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "earlier turn" }] }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hello, no mention here" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const fanned = platform.sentMail[platform.sentMail.length - 1];
    expect(fanned?.content).toEqual({
      content: "hello, no mention here",
      replyTo: workbench.id,
    });
  });

  test("a mention fan-out under the context window carries no dropped-history recap", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 5 }),
    });

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "one" }] }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";
    expect(contextText).not.toContain("Earlier in this conversation");
  });

  test("a mention fan-out beyond the context window prepends a recap of the dropped history", async () => {
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

    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ kind: "text", text: "the launch date is March 3rd" }],
      }),
    });
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "kept one" }] }),
    });
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "kept two" }] }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    expect(contextText).toContain("Earlier in this conversation");
    // 2, not 1: the workbench's own join event (from inviting ins_echo1 at
    // creation) is itself a dropped mail row, alongside "the launch
    // date" message — both fall outside the window of 2.
    expect(contextText).toContain("2 older messages");
    expect(contextText).toContain("the launch date is March 3rd");
    expect(contextText).toContain("user: kept one"); // still in-window
    expect(contextText).toContain("user: kept two"); // still in-window
    // The recap line itself precedes the still-in-window items.
    const lines = contextText.split("\n");
    const recapIndex = lines.findIndex((line) =>
      line.includes("Earlier in this conversation"),
    );
    const keptIndex = lines.findIndex((line) => line === "user: kept two");
    expect(recapIndex).toBeGreaterThan(-1);
    expect(recapIndex).toBeLessThan(keptIndex);
    expect(lines[recapIndex]).toMatch(/^system: /);
  });

  test("an agents-only dropped span still yields an honest count line, never a fabricated quote", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example", "ins_echo2@acme.example"],
    });
    await app.request(`/workbenches/${workbench.id}/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "chat/contextWindow": 1 }),
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // Simulates an agent's own posted reply landing in the mailbox, the
    // way the orchestrator's `postReply` delivers it — no principalId.
    await platform.sendMail({
      tenantId: TENANT.id,
      workbenchId: workbench.id,
      fromWorkbenchId: "ins_echo2",
      content: { content: "agent-only reply, no facts a human said" },
    });
    await app.request(`/workbenches/${workbench.id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ kind: "text", text: "kept" }] }),
    });
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );
    expect(response.status).toBe(201);

    const copy = platform.sentMail[platform.sentMail.length - 1];
    const [contextPart] = decodeParts(copy?.content ?? { content: "" });
    const contextText = contextPart?.kind === "text" ? contextPart.text : "";

    // 2, not 1: the workbench's own join event (from the two participants
    // at creation) is itself a dropped mail row, alongside the agent's
    // reply — both fall outside the window of 1.
    expect(contextText).toContain("2 older messages");
    expect(contextText).not.toContain("agent-only reply");
    expect(contextText).toContain("no human messages");
  });

  test("a timeline load failure does not break the send; it fans out un-situated", async () => {
    const platform = fakePlatform();
    platform.listMail = () => {
      throw new Error("boom: platform unavailable");
    };
    const deps = buildDeps({ platform });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["ins_echo1@acme.example"],
    });

    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parts: [{ kind: "text", text: "hi @ins_echo1" }],
        }),
      },
    );

    expect(response.status).toBe(201);
    const copy = platform.sentMail[platform.sentMail.length - 1];
    expect(copy?.content).toEqual({
      content: "hi @ins_echo1",
      replyTo: workbench.id,
    });
  });

  test("inviting an agent joins it into the workbench and posts the join event", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    // Reply routing for the invited agent is the chat orchestrator's
    // concern now (see `chat-orchestrator.test.ts`), not a bridge this
    // route arms — this route only proves the join event was sent.
    expect(platform.sentMail.some((m) => m.workbenchId === workbench.id)).toBe(
      true,
    );
  });

  // CL-6120: a post-restart send that exhausts the adapter's own
  // reclaim-settle-then-redeploy budget must not surface as an
  // unhandled 500 with a raw "agent is unreachable" stack trace — the
  // route's job is to translate that into a clean, retriable response.
  test("a send that never becomes routable answers 503 with a plain-language message, not an unhandled 500", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        sendMail() {
          throw new AgentUnreachableError("ins_workbench1@acme.example");
        },
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const parts: Part[] = [{ kind: "text", text: "hello?" }];
    const response = await app.request(
      `/workbenches/${workbench.id}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts }),
      },
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "agent_unreachable",
        message:
          "The agent is reconnecting after a restart — try again in a moment.",
      },
    });
  });
});

describe("POST /workbenches/:id/invite", () => {
  test("launches the definition, appends the participant, and posts a join event", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      address: string;
      definitionId: string;
    };
    expect(body).toEqual({
      address: "ins_invited1@acme.example",
      definitionId: "wfd_echo",
    });

    const platform = deps.platform as ReturnType<typeof fakePlatform>;
    expect(platform.launchInviteCalls).toEqual([
      {
        tenantId: TENANT.id,
        creatorPrincipalId: "prn_alice",
        definitionId: "wfd_echo",
      },
    ]);

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "ins_invited1" },
    ]);

    expect(platform.sentMail).toHaveLength(1);
    const sent = platform.sentMail[0];
    expect(sent?.workbenchId).toBe(workbench.id);
    const decoded = JSON.parse(
      Buffer.from(
        (sent?.content.attachments?.[0]?.data ?? "") as string,
        "base64",
      ).toString("utf-8"),
    ) as { kind: string; event: string; data: { address: string } };
    expect(decoded.kind).toBe("event");
    expect(decoded.event).toBe("workbench.agent-joined");
    expect(decoded.data.address).toBe("ins_invited1@acme.example");
  });

  test("appends onto an existing participant list rather than replacing it", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["existing@acme.example"],
    });

    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "existing@acme.example", handle: "existing" },
      { address: "ins_invited1@acme.example", handle: "ins_invited1" },
    ]);
  });

  test("derives the mention handle from the invited definition's name, de-duplicating within the workbench", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [{ id: "wfd_echo", name: "Echo" }],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      participants: ["echo@acme.example"],
    });

    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "echo@acme.example", handle: "echo" },
      { address: "ins_invited1@acme.example", handle: "echo-2" },
    ]);
  });

  test("derives the mention handle from the invited definition's display name (description) over its asset name", async () => {
    const deps = buildDeps({
      platform: fakePlatform({
        invitable: [
          { id: "wfd_assistant", name: "assistant", description: "Myra" },
        ],
      }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_assistant" }),
    });

    const settingsRow = await deps.store.getWorkbenchSettings(
      TENANT.id,
      workbench.id,
    );
    expect(settingsRow?.settings["chat/participants"]).toEqual([
      { address: "ins_invited1@acme.example", handle: "myra" },
    ]);
  });

  test("a malformed body is rejected with the structured error envelope", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("bad_request");
  });

  test("a missing workbench is a 404", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_missing/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(404);
  });

  test("a denied grant is rejected before any launch is attempted", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const response = await app.request(`/workbenches/ins_x/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(403);
    expect(
      (platform as ReturnType<typeof fakePlatform>).launchInviteCalls,
    ).toHaveLength(0);
  });

  test("inviting a second agent into a chat grows it — no invite cap", async () => {
    const deps = buildDeps({
      platform: fakePlatform({ invitable: [{ id: "wfd_echo", name: "Echo" }] }),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "chat",
      definitionId: "wfd_echo",
    });

    const response = await app.request(`/workbenches/${workbench.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definitionId: "wfd_echo" }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { address: string };
    expect(body.address).toBe("ins_invited1@acme.example");
  });
});
