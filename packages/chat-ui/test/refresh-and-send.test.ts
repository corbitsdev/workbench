// Pure-logic tests for the reviewed defects fixed on the chat surface. This
// suite runs in bun's bare test environment (no DOM), so instead of mounting
// components it exercises the pure rules the fixes turned on: exactly the
// same rules `chat-workspace.tsx`, `composer.tsx`, and
// `use-channel-stream.ts` call from inside their hooks.

import { describe, expect, test } from "bun:test";

import {
  canInviteAgent,
  nextMessagesState,
  resolveMessageFeedTarget,
} from "../src/chat-workspace";
import type { MessagesState } from "../src/chat-workspace";
import {
  attachmentsAfterSend,
  attachmentBytesOnComposer,
  attachmentValidationMessage,
  base64DecodedByteLength,
  canAttachComposer,
  canSendComposer,
  canSendComposerAction,
  COMPOSER_ATTACHMENT_LIMITS,
  draftAfterSend,
  partsForSend,
  validateAttachmentPick,
} from "../src/composer";
import type { ComposerAttachment } from "../src/composer";
import { CHAT_STRINGS } from "../src/strings";
import { backoffDelayMs, shouldConnect } from "../src/use-channel-stream";

describe("nextMessagesState (B1: background refresh keeps the composer mounted)", () => {
  const ready: MessagesState = {
    kind: "ready",
    items: [
      {
        id: "m1",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{ kind: "text", text: "hi" }],
        sender: { name: null, address: "prn_fixture1@agents.example" },
      },
    ],
  };

  test("a foreground load reflects a fresh success directly", () => {
    const next = nextMessagesState(
      { kind: "loading" },
      { kind: "success", items: [] },
      false,
    );
    expect(next).toEqual({ kind: "ready", items: [] });
  });

  test("a foreground load's failure replaces the view with an error state", () => {
    const next = nextMessagesState(
      ready,
      { kind: "error", message: "boom" },
      false,
    );
    expect(next).toEqual({ kind: "error", message: "boom" });
  });

  test("a background refresh never re-enters the loading state on success", () => {
    const next = nextMessagesState(ready, { kind: "success", items: [] }, true);
    expect(next.kind).toBe("ready");
  });

  test("a background refresh's failure leaves the previous ready items on screen", () => {
    const next = nextMessagesState(
      ready,
      { kind: "error", message: "boom" },
      true,
    );
    expect(next).toBe(ready);
    expect(next.kind).not.toBe("error");
  });

  test("a background refresh's failure never clobbers even a prior loading state", () => {
    const loading: MessagesState = { kind: "loading" };
    const next = nextMessagesState(
      loading,
      { kind: "error", message: "boom" },
      true,
    );
    expect(next).toBe(loading);
  });
});

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

  test("is true for a channel", () => {
    expect(canInviteAgent("channel")).toBe(true);
  });

  test("defaults true with no resolved channel yet", () => {
    expect(canInviteAgent(undefined)).toBe(true);
  });

  test("is true for a kind this UI doesn't otherwise recognize", () => {
    expect(canInviteAgent("archive")).toBe(true);
  });
});

describe("resolveMessageFeedTarget (4a: root feed is root-thread only)", () => {
  test("open thread loads that thread's messages", () => {
    expect(
      resolveMessageFeedTarget({
        openThreadId: "thr_reply",
        pendingParentMessageId: null,
        rootThreadId: "thr_root",
      }),
    ).toEqual({ kind: "thread", threadId: "thr_reply" });
  });

  test("open thread wins over a pending parent", () => {
    expect(
      resolveMessageFeedTarget({
        openThreadId: "thr_reply",
        pendingParentMessageId: "msg_parent",
        rootThreadId: "thr_root",
      }),
    ).toEqual({ kind: "thread", threadId: "thr_reply" });
  });

  test("pending new reply loads an empty feed", () => {
    expect(
      resolveMessageFeedTarget({
        openThreadId: null,
        pendingParentMessageId: "msg_parent",
        rootThreadId: "thr_root",
      }),
    ).toEqual({ kind: "empty" });
  });

  test("root feed uses the root thread, not full channel mail", () => {
    expect(
      resolveMessageFeedTarget({
        openThreadId: null,
        pendingParentMessageId: null,
        rootThreadId: "thr_root",
      }),
    ).toEqual({ kind: "root-thread", rootThreadId: "thr_root" });
  });

  test("empty rootThreadId falls back to channel mail (threads unavailable)", () => {
    expect(
      resolveMessageFeedTarget({
        openThreadId: null,
        pendingParentMessageId: null,
        rootThreadId: "",
      }),
    ).toEqual({ kind: "channel-mail" });
  });

  test("null rootThreadId falls back to channel mail until threads resolve", () => {
    expect(
      resolveMessageFeedTarget({
        openThreadId: null,
        pendingParentMessageId: null,
        rootThreadId: null,
      }),
    ).toEqual({ kind: "channel-mail" });
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

describe("shouldConnect (S3: an empty channel url opens no connection)", () => {
  test("is false with no active channel", () => {
    expect(shouldConnect("")).toBe(false);
  });

  test("is true once a real stream url is known", () => {
    expect(shouldConnect("/api/tenants/tnt_1/chat/channels/c1/stream")).toBe(
      true,
    );
  });
});
