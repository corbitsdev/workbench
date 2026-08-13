import { describe, expect, test } from "bun:test";

import {
  createDeliveryThread,
  createInMemoryThreadStore,
  resolveTargetThread,
} from "./threads";

describe("resolveTargetThread", () => {
  test("explicit thread wins", () => {
    expect(
      resolveTargetThread({
        explicitThreadId: "thr_x",
        rootThreadId: "thr_root",
        inReplyToMessageId: "msg_1",
      }),
    ).toEqual({ threadId: "thr_x", needsReplyOpen: false });
  });

  test("reply opens when no reply thread yet", () => {
    expect(
      resolveTargetThread({
        rootThreadId: "thr_root",
        inReplyToMessageId: "msg_1",
      }),
    ).toEqual({ threadId: "thr_root", needsReplyOpen: true });
  });

  test("reply reuses existing reply thread", () => {
    expect(
      resolveTargetThread({
        rootThreadId: "thr_root",
        inReplyToMessageId: "msg_1",
        replyThreadId: "thr_reply",
      }),
    ).toEqual({ threadId: "thr_reply", needsReplyOpen: false });
  });

  test("default is root", () => {
    expect(resolveTargetThread({ rootThreadId: "thr_root" })).toEqual({
      threadId: "thr_root",
      needsReplyOpen: false,
    });
  });
});

describe("in-memory ThreadStore", () => {
  test("ensureRootThread is idempotent", async () => {
    const store = createInMemoryThreadStore();
    const a = await store.ensureRootThread("t1", "c1");
    const b = await store.ensureRootThread("t1", "c1");
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe("root");
  });

  test("createDeliveryThread is idempotent per runRef", async () => {
    const store = createInMemoryThreadStore();
    const a = await createDeliveryThread(store, {
      tenantId: "t1",
      channelId: "c1",
      runRef: "run_42",
      title: "Nightly report",
    });
    const b = await createDeliveryThread(store, {
      tenantId: "t1",
      channelId: "c1",
      runRef: "run_42",
    });
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe("delivery");
    expect(a.runRef).toBe("run_42");
  });

  test("openReplyThread is idempotent per parent message", async () => {
    const store = createInMemoryThreadStore();
    const a = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    const b = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    expect(a.id).toBe(b.id);
    expect(a.parentMessageId).toBe("msg_1");
  });

  test("assignMessage and listMessageIds", async () => {
    const store = createInMemoryThreadStore();
    const root = await store.ensureRootThread("t1", "c1");
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: root.id,
      messageId: "msg_a",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: root.id,
      messageId: "msg_b",
    });
    expect(await store.listMessageIds("t1", root.id)).toEqual([
      "msg_a",
      "msg_b",
    ]);
    expect(await store.threadIdForMessage("t1", "c1", "msg_a")).toBe(root.id);
  });

  test("listThreads returns root + delivery + reply", async () => {
    const store = createInMemoryThreadStore();
    await store.ensureRootThread("t1", "c1");
    await createDeliveryThread(store, {
      tenantId: "t1",
      channelId: "c1",
      runRef: "run_1",
    });
    await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    const list = await store.listThreads("t1", "c1");
    expect(list.map((t) => t.kind).sort()).toEqual([
      "delivery",
      "reply",
      "root",
    ]);
  });
});
