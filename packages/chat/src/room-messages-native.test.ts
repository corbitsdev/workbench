// The native timeline (CL-7594): frames in, `RoomMessage`s out, with the
// parts sidecar joined per page and text fallbacks for sidecar misses.
import { describe, expect, it } from "bun:test";

import { createInMemoryMessagePartsStore } from "./message-parts";
import {
  createNativeRoomMessageStore,
  type NativeTimelineDeps,
  type NativeTimelineFrame,
} from "./room-messages-native";
import { rootThreadId } from "./threads-native";

const TENANT = "ten_1";
const BENCH = "run_1";
const READER = "prn_reader";

function frame(
  msgId: string,
  extra?: Partial<NativeTimelineFrame>,
): NativeTimelineFrame {
  return {
    id: `pm_${msgId}`,
    messageId: `<${msgId}@mail.test>`,
    fromAddress: `${READER}@mail.test`,
    date: "2026-09-01T00:00:00.000Z",
    direction: "outbound",
    refs: [{ kind: "workbench", id: BENCH }],
    ...extra,
  };
}

function depsFor(frames: readonly NativeTimelineFrame[]): NativeTimelineDeps {
  const byMsgId = new Map(
    frames.map((entry) => [
      entry.messageId.replace(/^<(.+?)@.+>$/, "$1"),
      entry,
    ]),
  );
  return {
    listWorkbenchFrames: async () => ({ frames: [...frames] }),
    readFrame: async (_tenantId, _principalId, messageId) =>
      byMsgId.get(messageId),
    findFrame: async (_tenantId, mailMessageId) =>
      frames.find((entry) => entry.messageId === mailMessageId),
    findFrames: async (_tenantId, messageIds) =>
      frames.filter((entry) =>
        messageIds.includes(entry.messageId.replace(/^<(.+?)@.+>$/, "$1")),
      ),
    countFramesSince: async () => frames.length,
    resolveRunIds: async () => new Map(),
    resolveSenderNames: async (_tenantId, addresses) =>
      new Map(addresses.map((address) => [address, "Reader"] as const)),
    resolveTenantDomain: async () => "mail.test",
    parts: createInMemoryMessagePartsStore(),
  };
}

describe("createNativeRoomMessageStore", () => {
  it("maps a page of frames onto timeline messages", async () => {
    const deps = depsFor([
      frame("msg_b", { date: "2026-09-02T00:00:00.000Z" }),
      frame("msg_a"),
    ]);
    await deps.parts.recordMessageParts({
      tenantId: TENANT,
      mailMessageId: "<msg_a@mail.test>",
      workbenchId: BENCH,
      parts: [{ kind: "text", text: "hello" }],
    });
    const store = createNativeRoomMessageStore(deps, {
      threadIdOf: async () => rootThreadId(BENCH),
    });
    const page = await store.listMessages({
      tenantId: TENANT,
      workbenchId: BENCH,
      principalId: READER,
    });
    expect(page.items.map((entry) => entry.id)).toEqual(["msg_b", "msg_a"]);
    expect(page.items[0]?.mailMessageId).toBe("<msg_b@mail.test>");
    expect(page.items[0]?.parts).toEqual([]);
    expect(page.items[1]?.parts).toEqual([{ kind: "text", text: "hello" }]);
    expect(page.items[1]?.threadId).toBe(rootThreadId(BENCH));
    expect(page.items[1]?.senderPrincipalId).toBe(READER);
    expect(page.items[1]?.sender.name).toBe("Reader");
    expect(page.nextCursor).toBeUndefined();
  });

  it("falls back to frame text for sidecar misses, empty when unknown", async () => {
    const deps = depsFor([
      frame("msg_b", { fallbackText: "plain body" }),
      frame("msg_c"),
    ]);
    const store = createNativeRoomMessageStore(deps, {
      threadIdOf: async () => null,
    });
    const page = await store.listMessages({
      tenantId: TENANT,
      workbenchId: BENCH,
      principalId: READER,
    });
    expect(page.items[0]?.parts).toEqual([
      { kind: "text", text: "plain body" },
    ]);
    expect(page.items[1]?.parts).toEqual([]);
  });

  it("reads agent frames with no principal and inbound humans by address", async () => {
    const deps = depsFor([
      frame("msg_agent", {
        fromAddress: "agent+writer@mail.test",
        direction: "inbound",
      }),
      frame("msg_in", {
        fromAddress: "prn_other@mail.test",
        direction: "inbound",
      }),
    ]);
    const store = createNativeRoomMessageStore(deps, {
      threadIdOf: async () => null,
    });
    const page = await store.listMessages({
      tenantId: TENANT,
      workbenchId: BENCH,
      principalId: READER,
    });
    expect(page.items[0]?.senderPrincipalId).toBeNull();
    expect(page.items[1]?.senderPrincipalId).toBe("prn_other");
  });

  it("requires the reader for mailbox-scoped reads", async () => {
    const store = createNativeRoomMessageStore(depsFor([]), {
      threadIdOf: async () => null,
    });
    await expect(
      store.listMessages({ tenantId: TENANT, workbenchId: BENCH }),
    ).rejects.toThrow(/principalId/);
    await expect(
      store.listActivity({ tenantId: TENANT, workbenches: [] }),
    ).rejects.toThrow(/principalId/);
  });

  it("resolves single frames by msg_ id with and without a reader", async () => {
    const deps = depsFor([frame("msg_a")]);
    const store = createNativeRoomMessageStore(deps, {
      threadIdOf: async () => null,
    });
    const withReader = await store.getMessage({
      tenantId: TENANT,
      workbenchId: BENCH,
      messageId: "msg_a",
      principalId: READER,
    });
    expect(withReader?.id).toBe("msg_a");
    const systematic = await store.getMessage({
      tenantId: TENANT,
      workbenchId: BENCH,
      messageId: "msg_a",
    });
    expect(systematic?.id).toBe("msg_a");
    const found = await store.findByMailMessageId({
      tenantId: TENANT,
      mailMessageId: "<msg_a@mail.test>",
    });
    expect(found?.workbenchId).toBe(BENCH);
  });

  it("summarizes activity off the newest frame and unread counts", async () => {
    const deps = depsFor([frame("msg_a")]);
    await deps.parts.recordMessageParts({
      tenantId: TENANT,
      mailMessageId: "<msg_a@mail.test>",
      workbenchId: BENCH,
      parts: [{ kind: "text", text: "newest" }],
    });
    const store = createNativeRoomMessageStore(deps, {
      threadIdOf: async () => null,
    });
    const activity = await store.listActivity({
      tenantId: TENANT,
      principalId: READER,
      workbenches: [{ workbenchId: BENCH }],
    });
    expect(activity[BENCH]?.unreadCount).toBe(1);
    expect(activity[BENCH]?.lastActivityAt).toBe("2026-09-01T00:00:00.000Z");
    expect(activity[BENCH]?.preview).toBe("newest");
  });

  it("has no writes left: insert, stamp, and delete all throw", async () => {
    const store = createNativeRoomMessageStore(depsFor([]), {
      threadIdOf: async () => null,
    });
    await expect(
      store.insertMessage({
        tenantId: TENANT,
        workbenchId: BENCH,
        id: "msg_new",
        sender: { name: null, address: "u@mail.test" },
        parts: [],
      }),
    ).rejects.toThrow();
    await expect(
      store.stampMailMessageId({
        tenantId: TENANT,
        workbenchId: BENCH,
        messageId: "msg_a",
        mailMessageId: "<msg_a@mail.test>",
      }),
    ).rejects.toThrow();
    await expect(
      store.deleteMessage({
        tenantId: TENANT,
        workbenchId: BENCH,
        messageId: "msg_a",
      }),
    ).rejects.toThrow();
  });
});
