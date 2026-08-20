// CL-6328: a workbench stream subscriber must be able to render every
// event it receives with no follow-up GET. `chat.reaction` and
// `chat.pin`'s own payload completeness is pinned in
// `reactions-routes.test.ts`/`pins-routes.test.ts`; this covers
// `chat.message` and `chat.settings`.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createWorkbenchSubscriberRegistry } from "../src/workbench-events";
import type { ChatWorkbenchEvent } from "../src/platform-port";
import { buildDeps, createWorkbench, mountAs, sendText } from "./test-support";

describe("chat.message — payload completeness", () => {
  test("a published chat.message carries the full rendered row: sender and parts, not just enough to key a refetch", async () => {
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({ workbenchSubscribers });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
    });

    const received: ChatWorkbenchEvent[] = [];
    workbenchSubscribers.subscribe(workbench.id, (event) =>
      received.push(event),
    );

    await sendText(app, workbench.id, "morning");

    const messageEvents = received.filter(
      (event) => event.type === "chat.message",
    );
    expect(messageEvents).toHaveLength(1);
    const data = messageEvents[0]?.data as {
      id: string;
      sender: { name: string | null; address: string };
      parts: { kind: string; text?: string }[];
    };

    // The same row `GET /workbenches/:id/messages` would hand back for
    // this message — a subscriber never has to ask for it again.
    const list = await app.request(`/workbenches/${workbench.id}/messages`);
    const listed = (await list.json()) as {
      items: { id: string; sender: unknown; parts: unknown }[];
    };
    const fetched = listed.items.find((item) => item.id === data.id);
    expect(fetched).toBeDefined();
    expect(data.sender).toEqual(fetched?.sender as typeof data.sender);
    expect(data.parts).toEqual(fetched?.parts as typeof data.parts);
    expect(data.parts).toEqual([{ kind: "text", text: "morning" }]);
  });
});

describe("chat.settings — payload completeness", () => {
  test("a published chat.settings carries the full changed settings object, not a diff", async () => {
    const workbenchSubscribers = createWorkbenchSubscriberRegistry();
    const deps = buildDeps({ workbenchSubscribers });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body: workbench } = await createWorkbench(app, {
      kind: "workbench",
      name: "Original name",
    });

    const received: ChatWorkbenchEvent[] = [];
    workbenchSubscribers.subscribe(workbench.id, (event) =>
      received.push(event),
    );

    const response = await app.request(
      `/workbenches/${workbench.id}/settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ "chat/name": "Renamed" }),
      },
    );
    expect(response.status).toBe(200);

    const settingsEvents = received.filter(
      (event) => event.type === "chat.settings",
    );
    expect(settingsEvents).toHaveLength(1);
    const data = settingsEvents[0]?.data as {
      updatedBy: string;
      settings: Record<string, unknown>;
    };
    expect(data.updatedBy).toBe("prn_alice");
    expect(data.settings["chat/name"]).toBe("Renamed");
  });
});
