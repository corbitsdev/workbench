import { afterEach, describe, expect, test } from "bun:test";
import { CHAT_STRINGS } from "@corbits/chat-ui";

import { createChatBlockResponseActions } from "./block-response-actions";

describe("createChatBlockResponseActions copy", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubStatus(status: number): void {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "nope" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;
  }

  function actions() {
    return createChatBlockResponseActions("tenant-1", "wb_1");
  }

  test("form 403 uses form-submit forbidden, not approve copy", async () => {
    stubStatus(403);
    const result = await actions().submitForm("msg_1", "form_1", {
      name: "Ada",
    });
    expect(result).toEqual({
      kind: "forbidden",
      message: CHAT_STRINGS.blockFormSubmitForbidden,
    });
    expect(CHAT_STRINGS.blockFormSubmitForbidden).not.toBe(
      CHAT_STRINGS.blockApproveActionForbidden,
    );
  });

  test("poll and question 403 share form-submit forbidden copy", async () => {
    stubStatus(403);
    const ports = actions();
    const poll = await ports.submitPoll("msg_1", "poll_1", ["choice_1"]);
    const question = await ports.submitQuestion("msg_1", "q_1", "yes", 0);
    expect(poll).toEqual({
      kind: "forbidden",
      message: CHAT_STRINGS.blockFormSubmitForbidden,
    });
    expect(question).toEqual({
      kind: "forbidden",
      message: CHAT_STRINGS.blockFormSubmitForbidden,
    });
  });
});
