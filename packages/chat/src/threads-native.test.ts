// Descriptor threads (CL-7594): ids parse back into anchors, opens are
// idempotent constructors, and membership derives off headers.
import { describe, expect, it } from "bun:test";

import {
  ancestryOfDescriptor,
  createDescriptorThreadStore,
  deliveryThreadId,
  deriveThreadId,
  deriveThreadIds,
  parseThreadDescriptor,
  replyThreadId,
  rootThreadId,
  subThreadId,
  threadAncestryMessageIds,
  type DescriptorThreadDeps,
  type NativeFrameHeaders,
} from "./threads-native";
import { ThreadDepthCapError } from "./threads";

const TENANT = "ten_1";
const BENCH = "run_1";

function header(
  msgId: string,
  extra?: Partial<NativeFrameHeaders>,
): NativeFrameHeaders {
  return {
    messageId: `<${msgId}@mail.test>`,
    msgId,
    workbenchId: BENCH,
    date: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

function depsFor(headers: readonly NativeFrameHeaders[]): DescriptorThreadDeps {
  const byMsgId = new Map(headers.map((entry) => [entry.msgId, entry]));
  return {
    findFrameHeaders: async (_tenantId, messageIds) => {
      const result = new Map<string, NativeFrameHeaders>();
      for (const id of messageIds) {
        const found = byMsgId.get(id);
        if (found !== undefined) result.set(id, found);
      }
      return result;
    },
    listWorkbenchFrameHeaders: async () => [...headers],
  };
}

describe("parseThreadDescriptor", () => {
  it("round-trips every descriptor shape", () => {
    expect(parseThreadDescriptor(rootThreadId(BENCH))).toEqual({
      kind: "root",
      workbenchId: BENCH,
    });
    expect(parseThreadDescriptor(replyThreadId("msg_abc"))).toEqual({
      kind: "reply",
      parentMessageId: "msg_abc",
    });
    expect(
      parseThreadDescriptor(subThreadId(replyThreadId("msg_a"), "msg_b")),
    ).toEqual({
      kind: "sub",
      parentThreadId: replyThreadId("msg_a"),
      anchorMessageId: "msg_b",
    });
    expect(parseThreadDescriptor(deliveryThreadId("run_9"))).toEqual({
      kind: "delivery",
      runRef: "run_9",
    });
  });

  it("rejects legacy thr_ ids and truncated prefixes", () => {
    expect(parseThreadDescriptor("thr_abcdef123456")).toBeUndefined();
    expect(parseThreadDescriptor("thr_root_")).toBeUndefined();
    expect(parseThreadDescriptor("thr_reply_")).toBeUndefined();
    expect(parseThreadDescriptor("thr_delivery_")).toBeUndefined();
    expect(parseThreadDescriptor("thr_sub_nothing")).toBeUndefined();
  });

  it("keeps run refs with underscores intact through sub-threads", () => {
    const parent = deliveryThreadId("run_with_underscores");
    const sub = subThreadId(parent, "msg_b");
    expect(parseThreadDescriptor(sub)).toEqual({
      kind: "sub",
      parentThreadId: parent,
      anchorMessageId: "msg_b",
    });
  });

  it("rejects sub-threads under root or sub-threads", () => {
    expect(
      parseThreadDescriptor(subThreadId(rootThreadId(BENCH), "msg_b")),
    ).toBeUndefined();
    expect(
      parseThreadDescriptor(
        `${"thr_sub_"}${subThreadId(replyThreadId("msg_a"), "msg_b")}_msg_c`,
      ),
    ).toBeUndefined();
  });
});

describe("ancestryOfDescriptor", () => {
  it("answers the anchor chain root-first, capped at two", () => {
    expect(ancestryOfDescriptor(rootThreadId(BENCH))).toEqual([]);
    expect(ancestryOfDescriptor(deliveryThreadId("run_1"))).toEqual([]);
    expect(ancestryOfDescriptor(replyThreadId("msg_a"))).toEqual(["msg_a"]);
    expect(
      ancestryOfDescriptor(subThreadId(replyThreadId("msg_a"), "msg_b")),
    ).toEqual(["msg_a", "msg_b"]);
    expect(ancestryOfDescriptor("thr_legacy")).toEqual([]);
  });

  it("frames ancestry as Message-IDs for dispatches", () => {
    expect(
      threadAncestryMessageIds(subThreadId(replyThreadId("msg_a"), "msg_b"), (rowId) => `<${rowId}@mail.test>`),
    ).toEqual(["<msg_a@mail.test>", "<msg_b@mail.test>"]);
    expect(threadAncestryMessageIds(null, (rowId) => rowId)).toEqual([]);
  });
});

describe("deriveThreadId", () => {
  const a = header("msg_a");
  const b = header("msg_b", { inReplyTo: "<msg_a@mail.test>" });
  const c = header("msg_c", { inReplyTo: "<msg_b@mail.test>" });
  const d = header("msg_d", { inReplyTo: "<msg_c@mail.test>" });
  const byMsgId = new Map([
    ["msg_a", a],
    ["msg_b", b],
    ["msg_c", c],
    ["msg_d", d],
  ]);

  it("reads root-feed frames into the root descriptor", () => {
    expect(deriveThreadId(a, byMsgId, BENCH)).toBe(rootThreadId(BENCH));
  });

  it("opens reply threads under root-feed parents", () => {
    expect(deriveThreadId(b, byMsgId, BENCH)).toBe(replyThreadId("msg_a"));
  });

  it("nests sub-threads under depth-1 parents and siblings under depth-2", () => {
    expect(deriveThreadId(c, byMsgId, BENCH)).toBe(
      subThreadId(replyThreadId("msg_a"), "msg_b"),
    );
    expect(deriveThreadId(d, byMsgId, BENCH)).toBe(
      subThreadId(replyThreadId("msg_a"), "msg_c"),
    );
  });

  it("prefers stamped refs over header derivation", () => {
    const stamped = header("msg_x", {
      inReplyTo: "<msg_a@mail.test>",
      threadRef: replyThreadId("msg_z"),
    });
    expect(
      deriveThreadId(stamped, new Map([["msg_x", stamped], ...byMsgId]), BENCH),
    ).toBe(replyThreadId("msg_z"));
    const delivered = header("msg_y", { deliveryRef: { id: "run_7" } });
    expect(
      deriveThreadId(delivered, new Map([["msg_y", delivered]]), BENCH),
    ).toBe(deliveryThreadId("run_7"));
  });

  it("roots frames answering foreign or non-chat parents", () => {
    const foreignParent = header("msg_f", {
      inReplyTo: "<msg_other@mail.test>",
    });
    const withForeign = new Map([
      ["msg_f", foreignParent],
      [
        "msg_other",
        header("msg_other", {
          inReplyTo: "<msg_a@mail.test>",
          workbenchId: "run_other",
        }),
      ],
    ]);
    expect(deriveThreadId(foreignParent, withForeign, BENCH)).toBe(
      rootThreadId(BENCH),
    );
    const bracket = header("msg_g", { inReplyTo: "<run.started@mail.test>" });
    expect(
      deriveThreadId(bracket, new Map([["msg_g", bracket]]), BENCH),
    ).toBe(rootThreadId(BENCH));
  });

  it("derives a whole scan consistently", () => {
    const derived = deriveThreadIds([a, b, c, d], BENCH);
    expect(derived.get("msg_d")).toBe(
      subThreadId(replyThreadId("msg_a"), "msg_c"),
    );
    expect(derived.size).toBe(4);
  });
});

describe("createDescriptorThreadStore", () => {
  it("constructs the root idempotently without mail", async () => {
    const store = createDescriptorThreadStore(depsFor([]));
    const first = await store.ensureRootThread(TENANT, BENCH);
    const second = await store.ensureRootThread(TENANT, BENCH);
    expect(first.id).toBe(rootThreadId(BENCH));
    expect(second.id).toBe(first.id);
    expect(first.kind).toBe("root");
  });

  it("opens reply threads under root-feed messages and refuses depth-2", async () => {
    const a = header("msg_a");
    const b = header("msg_b", { inReplyTo: "<msg_a@mail.test>" });
    const c = header("msg_c", { inReplyTo: "<msg_b@mail.test>" });
    const store = createDescriptorThreadStore(depsFor([a, b, c]));
    const opened = await store.openReplyThread({
      tenantId: TENANT,
      workbenchId: BENCH,
      parentMessageId: "msg_a",
    });
    expect(opened.id).toBe(replyThreadId("msg_a"));
    expect(opened.parentThreadId).toBe(rootThreadId(BENCH));
    await expect(
      store.openReplyThread({
        tenantId: TENANT,
        workbenchId: BENCH,
        parentMessageId: "msg_c",
      }),
    ).rejects.toBeInstanceOf(ThreadDepthCapError);
  });

  it("redirects forks off depth-2 messages to a sibling sub-thread", async () => {
    const a = header("msg_a");
    const b = header("msg_b", { inReplyTo: "<msg_a@mail.test>" });
    const c = header("msg_c", { inReplyTo: "<msg_b@mail.test>" });
    const store = createDescriptorThreadStore(depsFor([a, b, c]));
    const forked = await store.forkThread({
      tenantId: TENANT,
      workbenchId: BENCH,
      parentMessageId: "msg_c",
    });
    expect(forked.id).toBe(
      subThreadId(replyThreadId("msg_a"), "msg_c"),
    );
  });

  it("resolves delivery titles off the reader's copies", async () => {
    const delivered = header("msg_y", {
      deliveryRef: { id: "run_7", label: "Nightly review" },
    });
    const store = createDescriptorThreadStore(depsFor([delivered]));
    const threadId = deliveryThreadId("run_7");
    const withoutReader = await store.getThread(TENANT, BENCH, threadId);
    expect(withoutReader?.runRef).toBe("run_7");
    expect(withoutReader?.title).toBeNull();
    const withReader = await store.getThread(TENANT, BENCH, threadId, "u_1");
    expect(withReader?.title).toBe("Nightly review");
    expect(withReader?.kind).toBe("delivery");
    expect(await store.getThread(TENANT, BENCH, "thr_legacy")).toBeUndefined();
  });

  it("lists threads and assignments off a scan", async () => {
    const a = header("msg_a");
    const b = header("msg_b", { inReplyTo: "<msg_a@mail.test>" });
    const delivered = header("msg_y", {
      deliveryRef: { id: "run_7", label: "Nightly review" },
    });
    const store = createDescriptorThreadStore(depsFor([a, b, delivered]));
    const threads = await store.listThreads(TENANT, BENCH, "u_1");
    expect(threads.map((entry) => entry.id).sort()).toEqual(
      [rootThreadId(BENCH), replyThreadId("msg_a"), deliveryThreadId("run_7")].sort(),
    );
    const assignments = await store.listThreadAssignments(TENANT, BENCH, "u_1");
    expect(assignments.get("msg_a")).toBe(rootThreadId(BENCH));
    expect(assignments.get("msg_b")).toBe(replyThreadId("msg_a"));
    expect(await store.listMessageIds(TENANT, BENCH, replyThreadId("msg_a"), "u_1")).toEqual([
      "msg_b",
    ]);
    expect(await store.threadIdForMessage(TENANT, BENCH, "msg_b")).toBe(
      replyThreadId("msg_a"),
    );
    expect(await store.threadIdForMessage(TENANT, BENCH, "msg_missing")).toBeUndefined();
  });

  it("creates delivery descriptors purely", async () => {
    const store = createDescriptorThreadStore(depsFor([]));
    const created = await store.createDeliveryThread({
      tenantId: TENANT,
      workbenchId: BENCH,
      runRef: "run_7",
      title: "Nightly review",
    });
    expect(created.id).toBe(deliveryThreadId("run_7"));
    expect(created.title).toBe("Nightly review");
  });
});
