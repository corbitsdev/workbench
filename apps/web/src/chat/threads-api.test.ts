import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { buildMailFrame } from "@corbits/mailbox";

import { ChatApiError, frameBody, sendToWorkbench } from "./threads-api";
import { appendRoster, stripRoster } from "./workbench-roster";

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => {
  fetchSpy.mockReset();
});

function send(status: number, code?: string) {
  fetchSpy.mockResolvedValue(
    new Response(JSON.stringify(code === undefined ? {} : { error: { code } }), { status }),
  );
  return sendToWorkbench({
    workbenchTenantId: "t1",
    participants: [{ id: "a1", kind: "agent", name: "Scout", address: "run_abc@example.test" }],
    content: "hello",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("sendToWorkbench failures", () => {
  test("a terminal run says the agent has finished", async () => {
    const error = await send(409, "workflow_run_terminal");
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).message).toBe(
      "This agent has finished and can't take new messages.",
    );
    expect((error as ChatApiError).status).toBe(409);
  });

  test("other statuses keep the unreachable message", async () => {
    const error = await send(500);
    expect((error as ChatApiError).message).toBe("The workbench could not be reached (500).");
  });

  for (const code of ["deployment_unreachable", "invalid_workflow"]) {
    test(`409 ${code} keeps the unreachable message`, async () => {
      const error = await send(409, code);
      expect((error as ChatApiError).message).toBe("The workbench could not be reached (409).");
    });
  }
});

describe("frameBody", () => {
  test("a roster-bearing frame built by the mailbox hub reads back without the roster", () => {
    const body = appendRoster("Hello there", [
      { name: "Ada", address: "ada@example.com", kind: "person" },
      { name: "Echo", address: "echo@example.com", kind: "agent" },
    ]);
    const frame = buildMailFrame({
      from: "ada@example.com",
      to: "echo@example.com",
      subject: "Hi",
      body,
      messageId: "<one@example.com>",
    });
    const raw = btoa(String.fromCharCode(...frame));

    const text = frameBody(raw);

    expect(text).not.toContain("\r");
    expect(stripRoster(text)).toBe("Hello there");
  });
});
