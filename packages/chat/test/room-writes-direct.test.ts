// The point of CL-6327, as a test: sending a message into a workbench
// writes the room and reaches for nothing else. The platform is armed to
// refuse every call the moment the message POST starts, so a 201 and a
// readable timeline against a refusing platform is proof the write and
// read paths never touch the execution plane. Asking the agent for a
// turn is the one platform call the send still makes, and it happens
// after the sender's own message is durable, through the one dispatch
// seam CL-6329 replaces.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import {
  buildDeps,
  createWorkbench,
  fakePlatform,
  mountAs,
  settleFanout,
  TENANT,
} from "./test-support";

async function chatWithAnAgent() {
  const platform = fakePlatform({
    invitable: [{ id: "wfd_echo", name: "echo" }],
  });
  const calls: string[] = [];
  let refuseCalls = false;
  const recorded = new Proxy(platform, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || property === "subscribeToWorkbench") {
        return value;
      }
      return (...args: unknown[]) => {
        calls.push(String(property));
        if (refuseCalls) {
          throw new Error(
            `the write path called the platform: ${String(property)}`,
          );
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });

  const deps = buildDeps({ platform: recorded });
  const app = mountAs(createChatRoutes(deps), "prn_ada");
  const { body } = await createWorkbench(app, {
    kind: "chat",
    definitionId: "wfd_echo",
  });
  await settleFanout();

  return {
    app,
    deps,
    workbenchId: body.id,
    calls,
    armRefusal: () => {
      calls.length = 0;
      refuseCalls = true;
    },
    disarmRefusal: () => {
      refuseCalls = false;
    },
  };
}

async function postText(
  app: ReturnType<typeof mountAs>,
  workbenchId: string,
  text: string,
): Promise<Response> {
  return app.request(`/workbenches/${workbenchId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts: [{ kind: "text", text }] }),
  });
}

describe("a message POST", () => {
  test("answers 201 with every platform call refused", async () => {
    const chat = await chatWithAnAgent();
    chat.armRefusal();

    const response = await postText(chat.app, chat.workbenchId, "morning");
    const sent = (await response.json()) as { id: string };

    expect(response.status).toBe(201);
    const stored = await chat.deps.roomMessages.getMessage({
      tenantId: TENANT.id,
      workbenchId: chat.workbenchId,
      messageId: sent.id,
    });
    expect(stored?.parts).toEqual([{ kind: "text", text: "morning" }]);
  });

  test("the timeline renders with every agent process stopped", async () => {
    const chat = await chatWithAnAgent();
    chat.armRefusal();

    const posted = await postText(chat.app, chat.workbenchId, "anyone home?");
    const sent = (await posted.json()) as { id: string };
    // The turn dispatch fails against the refusing platform; the room
    // itself must not notice.
    await settleFanout();

    const listed = await chat.app.request(
      `/workbenches/${chat.workbenchId}/messages`,
    );
    const body = (await listed.json()) as {
      items: { id: string; parts: { kind: string; text?: string }[] }[];
    };

    expect(listed.status).toBe(200);
    expect(body.items.map((item) => item.id)).toContain(sent.id);
    expect(
      body.items.flatMap((item) =>
        item.parts.filter((part) => part.kind === "text").map((p) => p.text),
      ),
    ).toContain("anyone home?");
  });

  test("asking the agent for a turn is the only platform call a send makes", async () => {
    const chat = await chatWithAnAgent();
    chat.calls.length = 0;

    const response = await postText(chat.app, chat.workbenchId, "hello");
    expect(response.status).toBe(201);
    await settleFanout();

    // No mailbox read, no wake, no blob fetch — one dispatch, and only
    // because the turn itself is still mail-shaped until CL-6329.
    expect(chat.calls).toEqual(["sendMail"]);
  });
});
