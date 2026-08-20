// Store-level round trip and toggle semantics for message reactions —
// the in-memory `ReactionStore`, exercised the same way `store.test.ts`
// exercises `ChatStore`: no HTTP, no database, just the toggle/list
// contract every implementation (in-memory and drizzle alike) must
// honor.
import { describe, expect, test } from "bun:test";

import {
  aggregateReactions,
  aggregateReactionsByMessage,
  createInMemoryReactionStore,
} from "../src/reactions";

const TENANT = "tnt_1";
const WORKBENCH = "run_workbench1";

describe("ReactionStore — toggle semantics", () => {
  test("a first toggle adds the reaction", async () => {
    const store = createInMemoryReactionStore();
    const result = await store.toggleReaction({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "👍",
      principalId: "prn_alice",
    });
    expect(result.added).toBe(true);

    const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
      "m1",
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ emoji: "👍", principalId: "prn_alice" });
  });

  test("a second toggle from the same principal removes it — true on/off, never a counter", async () => {
    const store = createInMemoryReactionStore();
    const input = {
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "👍",
      principalId: "prn_alice",
    };
    await store.toggleReaction(input);
    const second = await store.toggleReaction(input);
    expect(second.added).toBe(false);

    const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
      "m1",
    ]);
    expect(rows).toHaveLength(0);
  });

  test("two principals reacting with the same emoji both persist independently", async () => {
    const store = createInMemoryReactionStore();
    await store.toggleReaction({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "🎉",
      principalId: "prn_alice",
    });
    await store.toggleReaction({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "🎉",
      principalId: "prn_bob",
    });

    const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
      "m1",
    ]);
    expect(rows).toHaveLength(2);
  });

  test("tenant isolation: a reaction in one tenant never appears in another's read", async () => {
    const store = createInMemoryReactionStore();
    await store.toggleReaction({
      tenantId: "tnt_1",
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "👍",
      principalId: "prn_alice",
    });
    await store.toggleReaction({
      tenantId: "tnt_2",
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "👍",
      principalId: "prn_alice",
    });

    const tenant1Rows = await store.listReactionsForMessages(
      "tnt_1",
      WORKBENCH,
      ["m1"],
    );
    expect(tenant1Rows).toHaveLength(1);
    expect(tenant1Rows[0]?.tenantId).toBe("tnt_1");
  });

  test("listReactionsForMessages is batched: one call covers every message id given", async () => {
    const store = createInMemoryReactionStore();
    await store.toggleReaction({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m1",
      emoji: "👍",
      principalId: "prn_alice",
    });
    await store.toggleReaction({
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m2",
      emoji: "❤️",
      principalId: "prn_bob",
    });

    const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
      "m1",
      "m2",
      "m3",
    ]);
    expect(rows.map((row) => row.messageId).sort()).toEqual(["m1", "m2"]);
  });

  test("an empty messageIds list short-circuits without touching the store", async () => {
    const store = createInMemoryReactionStore();
    const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, []);
    expect(rows).toEqual([]);
  });

  // The in-memory store's `toggleReaction` body has no `await` between
  // its has/set — it runs to completion in one turn of the JS event
  // loop, so it can never interleave with another call the way the
  // drizzle-backed store's two separate statements could (see
  // `reactions.drizzle.test.ts` for the real race that fix covers).
  // `Promise.all` here still proves it: with no interleaving possible,
  // two toggles of the same reaction settle exactly like two sequential
  // calls would — added, then removed — never a double-add or a crash.
  test("concurrent toggles of the same reaction can never interleave — the event loop serializes them", async () => {
    const store = createInMemoryReactionStore();
    const input = {
      tenantId: TENANT,
      workbenchId: WORKBENCH,
      messageId: "m_race",
      emoji: "👍",
      principalId: "prn_alice",
    };

    const [first, second] = await Promise.all([
      store.toggleReaction(input),
      store.toggleReaction(input),
    ]);

    expect([first.added, second.added]).toEqual([true, false]);
    const rows = await store.listReactionsForMessages(TENANT, WORKBENCH, [
      "m_race",
    ]);
    expect(rows).toHaveLength(0);
  });
});

describe("aggregateReactions / aggregateReactionsByMessage", () => {
  test("folds rows into per-emoji count + reactedByMe", () => {
    const rows = [
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        messageId: "m1",
        emoji: "👍",
        principalId: "prn_alice",
        createdAt: new Date(),
      },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        messageId: "m1",
        emoji: "👍",
        principalId: "prn_bob",
        createdAt: new Date(),
      },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        messageId: "m1",
        emoji: "🎉",
        principalId: "prn_bob",
        createdAt: new Date(),
      },
    ];

    const summaries = aggregateReactions(rows, "prn_alice");
    const byEmoji = new Map(summaries.map((s) => [s.emoji, s]));
    expect(byEmoji.get("👍")).toEqual({
      emoji: "👍",
      count: 2,
      reactedByMe: true,
    });
    expect(byEmoji.get("🎉")).toEqual({
      emoji: "🎉",
      count: 1,
      reactedByMe: false,
    });
  });

  test("groups a batched read by messageId", () => {
    const rows = [
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        messageId: "m1",
        emoji: "👍",
        principalId: "prn_alice",
        createdAt: new Date(),
      },
      {
        tenantId: TENANT,
        workbenchId: WORKBENCH,
        messageId: "m2",
        emoji: "🚀",
        principalId: "prn_alice",
        createdAt: new Date(),
      },
    ];
    const byMessage = aggregateReactionsByMessage(rows, "prn_bob");
    expect(byMessage.get("m1")).toEqual([
      { emoji: "👍", count: 1, reactedByMe: false },
    ]);
    expect(byMessage.get("m2")).toEqual([
      { emoji: "🚀", count: 1, reactedByMe: false },
    ]);
  });
});
