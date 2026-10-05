import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ChatApiError, sendToWorkbench } from "./threads-api";

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
