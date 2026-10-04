import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ChatApiError, sendToWorkbench } from "./threads-api";

const fetchSpy = spyOn(globalThis, "fetch");
afterEach(() => {
  fetchSpy.mockReset();
});

function send(status: number) {
  fetchSpy.mockResolvedValue(new Response("{}", { status }));
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
  test("409 says the worker has stopped", async () => {
    const error = await send(409);
    expect(error).toBeInstanceOf(ChatApiError);
    expect((error as ChatApiError).message).toBe(
      "This worker has finished its work and can't take new messages.",
    );
    expect((error as ChatApiError).status).toBe(409);
  });

  test("other statuses keep the unreachable message", async () => {
    const error = await send(500);
    expect((error as ChatApiError).message).toBe("The workbench could not be reached (500).");
  });
});
