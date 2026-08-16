import { afterEach, describe, expect, test } from "bun:test";

import { CHANNELS_MUTATED_EVENT, createChannel } from "../src/api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const channel = {
  id: "chat-1",
  kind: "chat",
  title: "Myra",
  participants: [],
  pinned: false,
};

describe("createChannel mutation event", () => {
  test("a successful create dispatches CHANNELS_MUTATED_EVENT with the tenant id", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(channel), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    const seen: string[] = [];
    const listener = (event: Event) => {
      seen.push((event as CustomEvent<{ tenantId: string }>).detail.tenantId);
    };
    window.addEventListener(CHANNELS_MUTATED_EVENT, listener);
    try {
      await createChannel("tnt_1", { kind: "chat", definitionId: "def_1" });
    } finally {
      window.removeEventListener(CHANNELS_MUTATED_EVENT, listener);
    }
    expect(seen).toEqual(["tnt_1"]);
  });

  test("a failed create dispatches nothing", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status: 422,
          headers: { "content-type": "application/json" },
        }),
      )) as unknown as typeof fetch;
    let fired = 0;
    const listener = () => {
      fired += 1;
    };
    window.addEventListener(CHANNELS_MUTATED_EVENT, listener);
    try {
      await expect(
        createChannel("tnt_1", { kind: "chat", definitionId: "def_1" }),
      ).rejects.toThrow();
    } finally {
      window.removeEventListener(CHANNELS_MUTATED_EVENT, listener);
    }
    expect(fired).toBe(0);
  });
});
