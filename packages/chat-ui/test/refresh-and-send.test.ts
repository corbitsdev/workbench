// Pure-logic tests for the reviewed defects fixed on the chat surface. This
// suite runs in bun's bare test environment (no DOM), so instead of mounting
// components it exercises the pure rules the fixes turned on: exactly the
// same rules `chat-workspace.tsx`, `composer.tsx`, and
// `use-workbench-stream.ts` call from inside their hooks.

import { describe, expect, test } from "bun:test";

import {
  appendReplyTimedOutNotice,
  canInviteAgent,
  composerPlaceholderFor,
  mergePendingSends,
  mergeStreamingReply,
  withScrollSnapshot,
} from "../src/chat-workspace";
import type { PendingSend } from "../src/chat-workspace";
import {
  attachmentsAfterSend,
  attachmentBytesOnComposer,
  attachmentValidationMessage,
  base64DecodedByteLength,
  canAttachComposer,
  canSendComposer,
  canSendComposerAction,
  COMPOSER_ATTACHMENT_LIMITS,
  composerSendVisualState,
  draftAfterSend,
  partsForSend,
  validateAttachmentPick,
} from "../src/composer";
import type { ComposerAttachment } from "../src/composer";
import { CHAT_STRINGS } from "../src/strings";
import { backoffDelayMs, shouldConnect } from "../src/use-workbench-stream";

describe("draftAfterSend (B2: a failed send keeps the draft)", () => {
  test("clears the draft once the send succeeds", () => {
    expect(draftAfterSend("hello", true)).toBe("");
  });

  test("keeps exactly what was typed when the send fails", () => {
    expect(draftAfterSend("hello there", false)).toBe("hello there");
  });
});

const sampleAttachment: ComposerAttachment = {
  id: "att_1",
  name: "notes.txt",
  mediaType: "text/plain",
  data: "aGVsbG8=",
};

describe("partsForSend (text + file wire shape)", () => {
  test("emits a text part and a file part with name, mediaType, and data", () => {
    expect(partsForSend("  hello  ", [sampleAttachment])).toEqual([
      { kind: "text", text: "hello" },
      {
        kind: "file",
        name: "notes.txt",
        mediaType: "text/plain",
        data: "aGVsbG8=",
      },
    ]);
  });

  test("omits empty trimmed text and still sends attachment-only parts", () => {
    expect(partsForSend("   ", [sampleAttachment])).toEqual([
      {
        kind: "file",
        name: "notes.txt",
        mediaType: "text/plain",
        data: "aGVsbG8=",
      },
    ]);
  });
});

describe("canSendComposer (attachment-only eligibility)", () => {
  test("allows send with attachments and no text", () => {
    expect(canSendComposer("", [sampleAttachment])).toBe(true);
  });

  test("blocks send when both text and attachments are empty", () => {
    expect(canSendComposer("   ", [])).toBe(false);
  });
});

describe("attachmentsAfterSend (clear on success, retain on failure)", () => {
  test("clears attachments after a successful send", () => {
    expect(attachmentsAfterSend([sampleAttachment], true)).toEqual([]);
  });

  test("keeps the same attachments when the send fails", () => {
    const previous = [sampleAttachment];
    expect(attachmentsAfterSend(previous, false)).toBe(previous);
  });
});

describe("validateAttachmentPick (count / per-file / total limits)", () => {
  const limits = COMPOSER_ATTACHMENT_LIMITS;

  test("accepts a pick within every limit", () => {
    expect(
      validateAttachmentPick(0, 0, [
        { name: "a.txt", size: 1024 },
        { name: "b.txt", size: 2048 },
      ]),
    ).toBeNull();
  });

  test("rejects when the pick would exceed max attachment count", () => {
    const candidates = Array.from({ length: limits.maxCount }, (_, i) => ({
      name: `f${i}.txt`,
      size: 1,
    }));
    expect(validateAttachmentPick(1, 0, candidates)).toEqual({
      kind: "count",
      max: limits.maxCount,
      attempted: limits.maxCount + 1,
    });
  });

  test("rejects a single file over the per-file limit before any read", () => {
    expect(
      validateAttachmentPick(0, 0, [
        { name: "huge.bin", size: limits.maxPerFileBytes + 1 },
      ]),
    ).toEqual({
      kind: "perFile",
      name: "huge.bin",
      size: limits.maxPerFileBytes + 1,
      max: limits.maxPerFileBytes,
    });
  });

  test("rejects when existing plus pick total exceeds the message total", () => {
    // Stay under the per-file ceiling so the total rule is what fires.
    const chunk = limits.maxPerFileBytes;
    const existing = limits.maxTotalBytes - chunk + 1;
    expect(
      validateAttachmentPick(1, existing, [{ name: "more.bin", size: chunk }]),
    ).toEqual({
      kind: "total",
      total: existing + chunk,
      max: limits.maxTotalBytes,
    });
  });

  test("is all-or-nothing: one oversize file fails the whole pick", () => {
    const error = validateAttachmentPick(0, 0, [
      { name: "ok.txt", size: 10 },
      { name: "bad.bin", size: limits.maxPerFileBytes + 1 },
    ]);
    expect(error?.kind).toBe("perFile");
  });

  test("maps validation errors to accessible composer copy", () => {
    expect(
      attachmentValidationMessage({
        kind: "count",
        max: 5,
        attempted: 6,
      }),
    ).toBe(CHAT_STRINGS.composerAttachmentCountError(5));
    expect(
      attachmentValidationMessage({
        kind: "perFile",
        name: "x.pdf",
        size: 1,
        max: 5 * 1024 * 1024,
      }),
    ).toBe(CHAT_STRINGS.composerAttachmentPerFileError("x.pdf", 5));
    expect(
      attachmentValidationMessage({
        kind: "total",
        total: 1,
        max: 15 * 1024 * 1024,
      }),
    ).toBe(CHAT_STRINGS.composerAttachmentTotalError(15));
  });
});

describe("base64DecodedByteLength / attachmentBytesOnComposer", () => {
  test("decodes padding-aware base64 lengths", () => {
    // "hello" → aGVsbG8=
    expect(base64DecodedByteLength("aGVsbG8=")).toBe(5);
    expect(base64DecodedByteLength("")).toBe(0);
  });

  test("sums attachment payload sizes on the composer", () => {
    expect(attachmentBytesOnComposer([sampleAttachment])).toBe(5);
  });
});

describe("composer busy state rules (preparing blocks send and attach)", () => {
  test("canSendComposerAction blocks while preparing even with content", () => {
    expect(
      canSendComposerAction("", [sampleAttachment], {
        sending: false,
        preparing: true,
      }),
    ).toBe(false);
  });

  test("canSendComposerAction blocks while sending", () => {
    expect(
      canSendComposerAction("hi", [], { sending: true, preparing: false }),
    ).toBe(false);
  });

  test("canSendComposerAction allows a ready draft", () => {
    expect(
      canSendComposerAction("hi", [], { sending: false, preparing: false }),
    ).toBe(true);
  });

  test("canAttachComposer is false while preparing or sending", () => {
    expect(canAttachComposer({ sending: false, preparing: true })).toBe(false);
    expect(canAttachComposer({ sending: true, preparing: false })).toBe(false);
    expect(canAttachComposer({ sending: false, preparing: false })).toBe(true);
  });
});

describe("canInviteAgent (a chat's agent is fixed at creation; the server 409s an invite into one)", () => {
  test("is false for a chat", () => {
    expect(canInviteAgent("chat")).toBe(false);
  });

  test("is true for a workbench", () => {
    expect(canInviteAgent("workbench")).toBe(true);
  });

  test("defaults true with no resolved workbench yet", () => {
    expect(canInviteAgent(undefined)).toBe(true);
  });

  test("is true for a kind this UI doesn't otherwise recognize", () => {
    expect(canInviteAgent("archive")).toBe(true);
  });
});

describe("composerPlaceholderFor (CL-6070: a chat's composer reads as a DM, not a workbench)", () => {
  test("names the counterpart for an agent chat", () => {
    expect(composerPlaceholderFor({ kind: "chat", title: "Myra" })).toBe(
      CHAT_STRINGS.composerPlaceholderChat("Myra"),
    );
  });

  test("names the counterpart for a person chat too — a chat's title is always its counterpart's name", () => {
    expect(composerPlaceholderFor({ kind: "chat", title: "Priya" })).toBe(
      CHAT_STRINGS.composerPlaceholderChat("Priya"),
    );
  });

  test("keeps the generic workbench copy for a workbench", () => {
    expect(
      composerPlaceholderFor({ kind: "workbench", title: "General" }),
    ).toBe(CHAT_STRINGS.composerPlaceholder);
  });

  test("keeps the generic copy with no workbench resolved yet", () => {
    expect(composerPlaceholderFor(undefined)).toBe(
      CHAT_STRINGS.composerPlaceholder,
    );
  });

  test("falls back to the unnamed-workbench label for a titleless chat", () => {
    expect(composerPlaceholderFor({ kind: "chat", title: "" })).toBe(
      CHAT_STRINGS.composerPlaceholderChat(CHAT_STRINGS.unnamedWorkbench),
    );
  });
});

// CL-6677: this notice used to render as a bare `event`-kind item with no
// ref id and no Retry — unlike `postUndeliveredNotice`'s server-side
// backstop for the same class of failure (a turn that ends with no
// reply). It now carries a `turnFailed` text part instead, so it renders
// through the same `FailedTurnStrip` treatment: ref id quotable, Retry
// wired.
describe("appendReplyTimedOutNotice (CL-6677: same ref+Retry backstop as the server-side notice)", () => {
  const serverItems = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text" as const, text: "hello" }],
      sender: { name: null, address: "prn_alice@acme.example" },
    },
  ];
  const participants = [{ address: "myra@agents.example", handle: "myra" }];

  test("no timeout leaves the timeline untouched", () => {
    expect(appendReplyTimedOutNotice(serverItems, null, participants)).toBe(
      serverItems,
    );
  });

  test("a timed-out turn appends a turnFailed text part carrying the ref id, attributed to the agent", () => {
    const withNotice = appendReplyTimedOutNotice(
      serverItems,
      "mt4ewrje-zvbmti",
      participants,
    );
    expect(withNotice).toHaveLength(2);
    expect(withNotice[1]?.parts).toEqual([
      {
        kind: "text",
        text: "No reply arrived — the agent may be unavailable. (ref mt4ewrje-zvbmti)",
        turnFailed: true,
      },
    ]);
    expect(withNotice[1]?.sender.address).toBe("myra@agents.example");
  });

  test("with no agent participant to attribute to, still appends the notice", () => {
    const withNotice = appendReplyTimedOutNotice(serverItems, "abc-123", []);
    expect(withNotice).toHaveLength(2);
    expect(withNotice[1]?.parts[0]).toMatchObject({ turnFailed: true });
    expect(withNotice[1]?.sender.address).toBe("");
  });
});

describe("withScrollSnapshot (CL-6252 #3: settings toggle preserves scroll position)", () => {
  test("records a new workbench's snapshot without disturbing another workbench's", () => {
    const withA = withScrollSnapshot(new Map(), "ch_a", {
      scrollTop: 120,
      pinned: false,
    });
    const withBoth = withScrollSnapshot(withA, "ch_b", {
      scrollTop: 0,
      pinned: true,
    });

    expect(withBoth.get("ch_a")).toEqual({ scrollTop: 120, pinned: false });
    expect(withBoth.get("ch_b")).toEqual({ scrollTop: 0, pinned: true });
  });

  test("overwrites a workbench's previous snapshot rather than keeping the stale one", () => {
    const first = withScrollSnapshot(new Map(), "ch_a", {
      scrollTop: 50,
      pinned: false,
    });
    const second = withScrollSnapshot(first, "ch_a", {
      scrollTop: 300,
      pinned: true,
    });

    expect(second.get("ch_a")).toEqual({ scrollTop: 300, pinned: true });
  });

  test("never mutates the map it was given", () => {
    const original = new Map();
    withScrollSnapshot(original, "ch_a", { scrollTop: 10, pinned: false });
    expect(original.size).toBe(0);
  });
});

describe("backoffDelayMs (exponential backoff + jitter, capped)", () => {
  test("the first attempt is the base delay with no jitter", () => {
    expect(backoffDelayMs(1, () => 0)).toBe(500);
  });

  test("doubles per attempt", () => {
    expect(backoffDelayMs(2, () => 0)).toBe(1000);
    expect(backoffDelayMs(3, () => 0)).toBe(2000);
    expect(backoffDelayMs(4, () => 0)).toBe(4000);
  });

  test("caps at the max delay once the exponential curve reaches it, regardless of jitter", () => {
    expect(backoffDelayMs(5, () => 0)).toBe(8000);
    expect(backoffDelayMs(20, () => 0)).toBe(8000);
    expect(backoffDelayMs(20, () => 1)).toBe(8000);
  });

  test("jitter adds up to 30% on top of the exponential value, never more", () => {
    expect(backoffDelayMs(1, () => 1)).toBe(650); // 500 + 500*0.3
    expect(backoffDelayMs(3, () => 1)).toBe(2600); // 2000 + 2000*0.3
  });

  test("jitter never pushes the delay past the cap", () => {
    expect(backoffDelayMs(4, () => 1)).toBe(5200); // 4000 + 4000*0.3, under cap
    expect(backoffDelayMs(5, () => 1)).toBe(8000); // would be 10400 uncapped
  });

  test("attempt numbers below 1 behave as attempt 1 (no negative exponent)", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(500);
    expect(backoffDelayMs(-3, () => 0)).toBe(500);
  });
});

describe("shouldConnect (S3: an empty workbench url opens no connection)", () => {
  test("is false with no active workbench", () => {
    expect(shouldConnect("")).toBe(false);
  });

  test("is true once a real stream url is known", () => {
    expect(shouldConnect("/api/tenants/tnt_1/chat/workbenches/c1/stream")).toBe(
      true,
    );
  });
});

describe("composerSendVisualState (CL-6103: the send button reflects state)", () => {
  test("empty draft, idle: muted/disabled", () => {
    expect(composerSendVisualState("", [], { sending: false })).toBe("empty");
  });

  test("draft present, idle: ready for the primary-orange treatment", () => {
    expect(composerSendVisualState("hi", [], { sending: false })).toBe("ready");
  });

  test("a send in flight always wins, even over an emptied draft", () => {
    expect(composerSendVisualState("", [], { sending: true })).toBe("sending");
    expect(composerSendVisualState("hi", [], { sending: true })).toBe(
      "sending",
    );
  });

  test("an attachment with no text still counts as something to send", () => {
    expect(
      composerSendVisualState("", [sampleAttachment], { sending: false }),
    ).toBe("ready");
  });
});

describe("mergePendingSends (CL-6103: optimistic sends fold into the timeline)", () => {
  const serverItems = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text" as const, text: "hello" }],
      sender: { name: null, address: "prn_alice@acme.example" },
    },
  ];

  test("no pending sends leaves the server list untouched", () => {
    expect(mergePendingSends(serverItems, [], "prn_alice")).toBe(serverItems);
  });

  test("a pending send appends after the server's own messages, marked sending", () => {
    const pending: PendingSend[] = [
      {
        nonce: "pending_1",
        text: "hi",
        attachments: [],
        createdAt: "2026-01-01T00:01:00.000Z",
        status: "sending",
      },
    ];
    const merged = mergePendingSends(serverItems, pending, "prn_alice");
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      pendingStatus: "sending",
      pendingNonce: "pending_1",
    });
    expect(merged[1]?.parts).toEqual([{ kind: "text", text: "hi" }]);
  });

  test("CL-6251 reopened: a pending item's own clientId matches its nonce, so it keys identically to whichever confirmed message later reconciles it", () => {
    const pending: PendingSend[] = [
      {
        nonce: "pending_1",
        text: "hi",
        attachments: [],
        createdAt: "2026-01-01T00:01:00.000Z",
        status: "sending",
      },
    ];
    const merged = mergePendingSends(serverItems, pending, "prn_alice");
    // The timeline keys every item by `clientId ?? id` (see
    // `WorkbenchTimeline`'s render loop) so a pending bubble and its later
    // confirmed copy — same `clientId` — update one DOM node in place
    // rather than unmount/remount as two unrelated items.
    expect(merged[1]?.clientId).toBe("pending_1");
  });

  test('a pending send\'s sender local part matches the signed-in principal, so it renders as "You"', () => {
    const pending: PendingSend[] = [
      {
        nonce: "pending_1",
        text: "hi",
        attachments: [],
        createdAt: "2026-01-01T00:01:00.000Z",
        status: "failed",
      },
    ];
    const merged = mergePendingSends([], pending, "prn_alice");
    expect(merged[0]?.sender.address.split("@")[0]).toBe("prn_alice");
    expect(merged[0]?.pendingStatus).toBe("failed");
  });
});

describe("mergePendingSends (CL-6251: clientId reconciliation never double-renders a send)", () => {
  const serverItems = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text" as const, text: "hello" }],
      sender: { name: null, address: "prn_alice@acme.example" },
    },
  ];
  const pending: PendingSend[] = [
    {
      nonce: "pending_1",
      text: "hi",
      attachments: [],
      createdAt: "2026-01-01T00:01:00.000Z",
      status: "sending",
    },
  ];

  test("stream-first: a confirmed item carrying this send's clientId lands before the POST resolves — no duplicate", () => {
    const itemsWithConfirmedCopy = [
      ...serverItems,
      {
        id: "m2",
        createdAt: "2026-01-01T00:01:05.000Z",
        parts: [{ kind: "text" as const, text: "hi" }],
        sender: { name: null, address: "prn_alice@acme.example" },
        clientId: "pending_1",
      },
    ];
    const merged = mergePendingSends(
      itemsWithConfirmedCopy,
      pending,
      "prn_alice",
    );
    expect(merged).toHaveLength(2);
    expect(
      merged.filter((item) => item.pendingStatus !== undefined),
    ).toHaveLength(0);
  });

  test("POST-first: the pending entry is still present when the confirmed item hasn't loaded yet — renders once, as pending", () => {
    const merged = mergePendingSends(serverItems, pending, "prn_alice");
    expect(merged).toHaveLength(2);
    expect(merged[1]?.pendingStatus).toBe("sending");
  });

  test("a confirmed item with a different clientId (another send, or none at all) never suppresses this pending entry", () => {
    const itemsWithUnrelatedClientId = [
      {
        id: "m2",
        createdAt: "2026-01-01T00:01:05.000Z",
        parts: [{ kind: "text" as const, text: "unrelated" }],
        sender: { name: null, address: "prn_alice@acme.example" },
        clientId: "pending_other",
      },
    ];
    const merged = mergePendingSends(
      itemsWithUnrelatedClientId,
      pending,
      "prn_alice",
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]?.pendingStatus).toBe("sending");
  });

  test("a failed send's single bubble stays exactly one bubble even once its clientId is confirmed (e.g. a stale retry landed)", () => {
    const failedPending: PendingSend[] = [
      {
        nonce: "pending_1",
        text: "hi",
        attachments: [],
        createdAt: "2026-01-01T00:01:00.000Z",
        status: "failed",
      },
    ];
    const itemsWithConfirmedCopy = [
      {
        id: "m2",
        createdAt: "2026-01-01T00:01:05.000Z",
        parts: [{ kind: "text" as const, text: "hi" }],
        sender: { name: null, address: "prn_alice@acme.example" },
        clientId: "pending_1",
      },
    ];
    const merged = mergePendingSends(
      itemsWithConfirmedCopy,
      failedPending,
      "prn_alice",
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.pendingStatus).toBeUndefined();
  });
});

describe("mergeStreamingReply (CL-6115: the in-progress agent reply folds into the timeline)", () => {
  const agent = { address: "myra@ins_abc123", handle: "myra" };
  const serverItems = [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [{ kind: "text" as const, text: "hello" }],
      sender: { name: null, address: "prn_alice@acme.example" },
    },
  ];

  test("no in-progress reply leaves the timeline untouched", () => {
    expect(mergeStreamingReply(serverItems, null, [agent])).toBe(serverItems);
  });

  test("a growing reply appends a streaming item attributed to the workbench's agent", () => {
    const merged = mergeStreamingReply(
      serverItems,
      { phase: "awaiting", text: "Working on it" },
      [agent],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      streaming: true,
      sender: { address: "myra@ins_abc123" },
    });
    expect(merged[1]?.parts).toEqual([{ kind: "text", text: "Working on it" }]);
  });

  test("no agent participant to attribute the reply to means no synthetic item", () => {
    const merged = mergeStreamingReply(
      serverItems,
      { phase: "awaiting", text: "hi" },
      [],
    );
    expect(merged).toBe(serverItems);
  });

  test("a pending reply with no tokens yet renders no ghost bubble — the typing line owns that phase", () => {
    const merged = mergeStreamingReply(
      serverItems,
      { phase: "awaiting", text: "" },
      [agent],
    );
    expect(merged).toBe(serverItems);
  });
});
