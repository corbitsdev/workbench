import { describe, expect, test } from "bun:test";
import { waitForReply, type SubscribeToChannel } from "./reply-wait";

describe("waitForReply", () => {
  test("resolves with the reply text from a chat.agent connector.reply event", async () => {
    let handler: ((event: unknown) => void) | undefined;
    const subscribe: SubscribeToChannel = (_channelId, onEvent) => {
      handler = onEvent as (event: unknown) => void;
      return () => {
        handler = undefined;
      };
    };

    const pending = waitForReply(subscribe, "channel_1", 1000);
    handler?.({
      type: "chat.agent",
      data: {
        type: "connector.reply",
        data: { content: "Hello from the agent" },
      },
    });

    expect(await pending).toBe("Hello from the agent");
  });

  test("ignores non-reply events on the same stream", async () => {
    let handler: ((event: unknown) => void) | undefined;
    const subscribe: SubscribeToChannel = (_channelId, onEvent) => {
      handler = onEvent as (event: unknown) => void;
      return () => undefined;
    };

    const pending = waitForReply(subscribe, "channel_1", 200);
    handler?.({ type: "chat.agent", data: { type: "reactor.gate.blocked" } });
    handler?.({ type: "chat.settings", data: {} });

    expect(await pending).toBeUndefined();
  });

  test("resolves with undefined after the timeout when no reply lands", async () => {
    const subscribe: SubscribeToChannel = () => () => undefined;
    const result = await waitForReply(subscribe, "channel_1", 10);
    expect(result).toBeUndefined();
  });

  test("unsubscribes once a reply resolves the wait", async () => {
    let unsubscribed = false;
    let handler: ((event: unknown) => void) | undefined;
    const subscribe: SubscribeToChannel = (_channelId, onEvent) => {
      handler = onEvent as (event: unknown) => void;
      return () => {
        unsubscribed = true;
      };
    };

    const pending = waitForReply(subscribe, "channel_1", 1000);
    handler?.({
      type: "chat.agent",
      data: { type: "connector.reply", data: { content: "done" } },
    });
    await pending;

    expect(unsubscribed).toBe(true);
  });
});
