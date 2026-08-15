import { describe, expect, test } from "bun:test";

import {
  createDeliveryThread,
  createInMemoryThreadStore,
  resolveTargetThread,
  resolveThreadAnchor,
  ThreadDepthCapError,
} from "./threads";
import type { ChannelThread } from "./threads";

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

function fakeThread(overrides: Partial<ChannelThread>): ChannelThread {
  return {
    id: "thr_x",
    tenantId: "t1",
    channelId: "c1",
    kind: "reply",
    parentMessageId: null,
    parentThreadId: null,
    runRef: null,
    title: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("resolveThreadAnchor", () => {
  const root = fakeThread({ id: "thr_root", kind: "root" });

  test("anchoring on the root feed opens a depth-1 thread", () => {
    expect(resolveThreadAnchor(root, root)).toEqual({
      parentThreadId: "thr_root",
      blocked: false,
    });
  });

  test("anchoring on a message already in a depth-1 thread opens a depth-2 sub-thread", () => {
    const depth1 = fakeThread({ id: "thr_1", parentThreadId: root.id });
    expect(resolveThreadAnchor(root, depth1)).toEqual({
      parentThreadId: "thr_1",
      blocked: false,
    });
  });

  test("anchoring on a message already in a depth-2 sub-thread is blocked and redirects to the grandparent", () => {
    const depth1 = fakeThread({ id: "thr_1", parentThreadId: root.id });
    const depth2 = fakeThread({ id: "thr_2", parentThreadId: depth1.id });
    expect(resolveThreadAnchor(root, depth2)).toEqual({
      parentThreadId: "thr_1",
      blocked: true,
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

  test("listThreadAssignments maps only the channel's assigned messages", async () => {
    const store = createInMemoryThreadStore();
    const root = await store.ensureRootThread("t1", "c1");
    const reply = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_a",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: root.id,
      messageId: "msg_a",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: reply.id,
      messageId: "msg_b",
    });
    const otherRoot = await store.ensureRootThread("t1", "c2");
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c2",
      threadId: otherRoot.id,
      messageId: "msg_c",
    });

    const assignments = await store.listThreadAssignments("t1", "c1");
    expect(Object.fromEntries(assignments)).toEqual({
      msg_a: root.id,
      msg_b: reply.id,
    });
    // A message nothing ever assigned is absent, not defaulted here —
    // the root-feed default belongs to the reader (see the threads
    // route in `./routes.ts`), so this stays a faithful report of what
    // was actually written.
    expect(assignments.has("msg_never_assigned")).toBe(false);
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

  test("openReplyThread on a root message opens a depth-1 thread parented on root", async () => {
    const store = createInMemoryThreadStore();
    const root = await store.ensureRootThread("t1", "c1");
    const thread = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    expect(thread.parentThreadId).toBe(root.id);
  });
});

describe("two-level thread cap (CL-5908, CL-5948)", () => {
  test("forking a message inside a depth-1 thread opens a depth-2 sub-thread", async () => {
    const store = createInMemoryThreadStore();
    const depth1 = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: depth1.id,
      messageId: "msg_2",
    });
    const depth2 = await store.forkThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_2",
    });
    expect(depth2.parentThreadId).toBe(depth1.id);
    expect(depth2.parentMessageId).toBe("msg_2");
  });

  test("openReplyThread refuses to nest past depth 2 with an honest error", async () => {
    const store = createInMemoryThreadStore();
    const depth1 = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: depth1.id,
      messageId: "msg_2",
    });
    const depth2 = await store.forkThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_2",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: depth2.id,
      messageId: "msg_3",
    });
    await expect(
      store.openReplyThread({
        tenantId: "t1",
        channelId: "c1",
        parentMessageId: "msg_3",
      }),
    ).rejects.toThrow(ThreadDepthCapError);
  });

  test("forking a message inside a depth-2 sub-thread creates a sibling under the same depth-1 parent, never a third level", async () => {
    const store = createInMemoryThreadStore();
    const depth1 = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: depth1.id,
      messageId: "msg_2",
    });
    const depth2 = await store.forkThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_2",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: depth2.id,
      messageId: "msg_3",
    });

    const sibling = await store.forkThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_3",
    });

    expect(sibling.id).not.toBe(depth2.id);
    expect(sibling.parentThreadId).toBe(depth1.id);
    expect(sibling.parentMessageId).toBe("msg_3");
  });

  test("forkThread is idempotent per origin message", async () => {
    const store = createInMemoryThreadStore();
    const depth1 = await store.openReplyThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_1",
    });
    await store.assignMessage({
      tenantId: "t1",
      channelId: "c1",
      threadId: depth1.id,
      messageId: "msg_2",
    });
    const a = await store.forkThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_2",
    });
    const b = await store.forkThread({
      tenantId: "t1",
      channelId: "c1",
      parentMessageId: "msg_2",
    });
    expect(a.id).toBe(b.id);
  });
});
