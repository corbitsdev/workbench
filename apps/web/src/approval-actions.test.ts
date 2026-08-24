import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { CHAT_STRINGS } from "@corbits/chat-ui";

import { createChatApprovalActions } from "./approval-actions";

describe("createChatApprovalActions copy", () => {
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
      )) as unknown as typeof fetch;
  }

  function actions() {
    return createChatApprovalActions(
      "tenant-1",
      new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
  }

  test("approve 403 uses approve forbidden copy, not deny", async () => {
    stubStatus(403);
    const result = await actions().approve("appr_1");
    expect(result).toEqual({
      kind: "forbidden",
      message: CHAT_STRINGS.blockApproveActionForbidden,
    });
    expect(CHAT_STRINGS.blockApproveActionForbidden).not.toBe(
      CHAT_STRINGS.blockDenyActionForbidden,
    );
  });

  test("reject 403 uses deny forbidden copy, not approve", async () => {
    stubStatus(403);
    const result = await actions().reject("appr_1");
    expect(result).toEqual({
      kind: "forbidden",
      message: CHAT_STRINGS.blockDenyActionForbidden,
    });
    expect(CHAT_STRINGS.blockDenyActionForbidden).not.toBe(
      CHAT_STRINGS.blockApproveActionForbidden,
    );
  });
});
