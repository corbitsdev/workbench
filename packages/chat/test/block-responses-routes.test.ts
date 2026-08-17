// HTTP surface for the poll/form response round-trip: membership gating,
// upsert-as-change-vote, poll aggregation, form privacy (never another
// principal's raw submission), the `messageId`+`blockId` anti-hijack scope,
// cross-tenant isolation, and the `block.response` event appended to the
// channel's own mail.
import { describe, expect, test } from "bun:test";

import { createChatRoutes } from "../src/routes";
import { createInMemoryBlockResponseStore } from "../src/block-responses";
import { createInMemoryChatStore } from "../src/store";
import type { ChatStore } from "../src/store";
import {
  buildDeps,
  createChannel,
  fakePlatform,
  mountAs,
  TENANT,
} from "./test-support";

function responsesUrl(channelId: string, messageId: string, blockId: string) {
  return `/channels/${channelId}/messages/${messageId}/blocks/${blockId}/responses`;
}

async function vote(
  app: ReturnType<typeof mountAs>,
  channelId: string,
  messageId: string,
  blockId: string,
  choiceIds: string[],
) {
  return app.request(responsesUrl(channelId, messageId, blockId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "poll", choiceIds }),
  });
}

async function submitForm(
  app: ReturnType<typeof mountAs>,
  channelId: string,
  messageId: string,
  blockId: string,
  values: Record<string, string>,
) {
  return app.request(responsesUrl(channelId, messageId, blockId), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "form", values }),
  });
}

async function getResponses(
  app: ReturnType<typeof mountAs>,
  channelId: string,
  messageId: string,
  blockId: string,
) {
  return app.request(responsesUrl(channelId, messageId, blockId));
}

async function newChannel(store: ChatStore) {
  const channelId = "run_channel1";
  await store.createChannelSettings({
    tenantId: TENANT.id,
    channelId,
    settings: { "chat/kind": "channel" },
    updatedBy: "prn_alice",
  });
  return channelId;
}

describe("block response routes — gating", () => {
  test("no blockResponses store injected: POST and GET both 404, never silently no-op", async () => {
    const deps = buildDeps();
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    const post = await vote(app, channelId, "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(404);

    const get = await getResponses(app, channelId, "m1", "blk_poll1");
    expect(get.status).toBe(404);
  });

  test("a denied grant is rejected before any response is stored", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({
      blockResponses: store,
      requireGrant: () => async (c) =>
        c.json({ error: { code: "forbidden", message: "no" } }, 403),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    const post = await vote(app, channelId, "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(403);

    const rows = await store.listBlockResponses(
      TENANT.id,
      channelId,
      "m1",
      "blk_poll1",
    );
    expect(rows).toHaveLength(0);
  });

  test("an unknown channel id 404s rather than accepting a response into nowhere", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");

    const post = await vote(app, "run_ghost", "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(404);
  });

  test("a channel that belongs to a different tenant is invisible: 404, not leaked cross-tenant", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({ blockResponses: store });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const { body } = await createChannel(app, {
      kind: "channel",
      name: "General",
    });

    const otherTenantStore = createInMemoryChatStore();
    const otherDeps = buildDeps({
      store: otherTenantStore,
      blockResponses: store,
    });
    const otherApp = mountAs(createChatRoutes(otherDeps), "prn_mallory");

    const post = await vote(otherApp, body.id, "m1", "blk_poll1", ["a"]);
    expect(post.status).toBe(404);
    const get = await getResponses(otherApp, body.id, "m1", "blk_poll1");
    expect(get.status).toBe(404);
  });
});

describe("block response routes — poll aggregation and change-vote", () => {
  test("a vote is tallied and reported as this principal's own response", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    const post = await vote(app, channelId, "m1", "blk_poll1", ["tue"]);
    expect(post.status).toBe(200);

    const get = await getResponses(app, channelId, "m1", "blk_poll1");
    const body = (await get.json()) as {
      tally: Record<string, number>;
      total: number;
      own: unknown;
    };
    expect(body.tally).toEqual({ tue: 1 });
    expect(body.total).toBe(1);
    expect(body.own).toEqual({ kind: "poll", choiceIds: ["tue"] });
  });

  test("a second vote from the same principal changes it — upsert, not a second respondent", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    await vote(app, channelId, "m1", "blk_poll1", ["tue"]);
    await vote(app, channelId, "m1", "blk_poll1", ["thu"]);

    const get = await getResponses(app, channelId, "m1", "blk_poll1");
    const body = (await get.json()) as {
      tally: Record<string, number>;
      total: number;
    };
    expect(body.tally).toEqual({ thu: 1 });
    expect(body.total).toBe(1);
  });

  test("multiple principals' votes tally correctly, and each only ever sees its own `own`", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({ blockResponses: store });
    const appAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const appBob = mountAs(createChatRoutes(deps), "prn_bob");
    const channelId = await newChannel(deps.store);

    await vote(appAlice, channelId, "m1", "blk_poll1", ["tue"]);
    await vote(appBob, channelId, "m1", "blk_poll1", ["tue"]);

    const asAlice = (await (
      await getResponses(appAlice, channelId, "m1", "blk_poll1")
    ).json()) as { tally: Record<string, number>; total: number; own: unknown };
    expect(asAlice.tally).toEqual({ tue: 2 });
    expect(asAlice.total).toBe(2);
    expect(asAlice.own).toEqual({ kind: "poll", choiceIds: ["tue"] });
  });

  test("an empty choiceIds array is rejected", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    const post = await vote(app, channelId, "m1", "blk_poll1", []);
    expect(post.status).toBe(400);
  });
});

describe("block response routes — form privacy", () => {
  test("a form submission is never returned to a different principal, only tallied nowhere", async () => {
    const store = createInMemoryBlockResponseStore();
    const deps = buildDeps({ blockResponses: store });
    const appAlice = mountAs(createChatRoutes(deps), "prn_alice");
    const appBob = mountAs(createChatRoutes(deps), "prn_bob");
    const channelId = await newChannel(deps.store);

    await submitForm(appAlice, channelId, "m1", "blk_form1", {
      feedback: "Alice's private notes",
    });

    const asBob = (await (
      await getResponses(appBob, channelId, "m1", "blk_form1")
    ).json()) as { own: unknown; tally: Record<string, number> };
    expect(asBob.own).toBeNull();
    expect(asBob.tally).toEqual({});

    const asAlice = (await (
      await getResponses(appAlice, channelId, "m1", "blk_form1")
    ).json()) as { own: unknown };
    expect(asAlice.own).toEqual({
      kind: "form",
      values: { feedback: "Alice's private notes" },
    });
  });
});

describe("block response routes — anti-hijack scope", () => {
  test("the same agent-authored blockId in two different messages never collides", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    await vote(app, channelId, "m1", "blk_shared", ["a"]);
    await vote(app, channelId, "m2", "blk_shared", ["b"]);

    const m1 = (await (
      await getResponses(app, channelId, "m1", "blk_shared")
    ).json()) as { tally: Record<string, number> };
    const m2 = (await (
      await getResponses(app, channelId, "m2", "blk_shared")
    ).json()) as { tally: Record<string, number> };
    expect(m1.tally).toEqual({ a: 1 });
    expect(m2.tally).toEqual({ b: 1 });
  });
});

describe("block response routes — question answers", () => {
  test("answering a question posts the answer into the channel as the responder's own message", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    const post = await app.request(
      responsesUrl(channelId, "m1", "blk_question1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "question",
          answer: "Production",
          optionIndex: 1,
        }),
      },
    );
    expect(post.status).toBe(200);

    // Two mail sends land: the answer-as-message, and the block.response
    // event -- both authored by the responding principal.
    expect(platform.sentMail).toHaveLength(2);
    expect(
      platform.sentMail.every((mail) => mail.principalId === "prn_alice"),
    ).toBe(true);

    const get = await getResponses(app, channelId, "m1", "blk_question1");
    const body = (await get.json()) as { own: unknown };
    expect(body.own).toEqual({
      kind: "question",
      answer: "Production",
      optionIndex: 1,
    });
  });

  test("a question response without answer text is rejected", async () => {
    const deps = buildDeps({
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    const post = await app.request(
      responsesUrl(channelId, "m1", "blk_question1"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "question", answer: "" }),
      },
    );
    expect(post.status).toBe(400);
  });
});

describe("block response routes — block.response event", () => {
  test("a response appends a machine-readable event into the channel's own mail", async () => {
    const platform = fakePlatform();
    const deps = buildDeps({
      platform,
      blockResponses: createInMemoryBlockResponseStore(),
    });
    const app = mountAs(createChatRoutes(deps), "prn_alice");
    const channelId = await newChannel(deps.store);

    await vote(app, channelId, "m1", "blk_poll1", ["tue"]);

    expect(platform.sentMail).toHaveLength(1);
    const sent = platform.sentMail[0];
    expect(sent?.principalId).toBe("prn_alice");
    const decoded = JSON.parse(
      Buffer.from(
        (sent?.content.attachments?.[0]?.data ?? "") as string,
        "base64",
      ).toString("utf-8"),
    ) as { kind: string; event: string; data: Record<string, unknown> };
    expect(decoded.kind).toBe("event");
    expect(decoded.event).toBe("block.response");
    expect(decoded.data).toMatchObject({
      messageId: "m1",
      blockId: "blk_poll1",
      kind: "poll",
      choiceIds: ["tue"],
    });
  });
});
