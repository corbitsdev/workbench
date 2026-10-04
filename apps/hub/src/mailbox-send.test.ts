import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { captureMailboxRequest, createMailboxDeliver } from "./mailbox-send";

function sendTo(triggerStatus: number, triggerBody: string) {
  const deliver = createMailboxDeliver({
    app: { request: () => new Response(triggerBody, { status: triggerStatus }) },
    persistMail: () => Promise.resolve(),
  });
  const app = new Hono();
  app.use("*", captureMailboxRequest());
  app.post("/api/tenants/:tenantId/send", async (c) => {
    await deliver({
      raw: new TextEncoder().encode("Subject: hi\r\n\r\nhello"),
      from: "me@example.test",
      to: ["run_abc@example.test"],
      messageId: "m1",
    });
    return c.json({ ok: true });
  });
  return app.request("/api/tenants/t1/send", { method: "POST" });
}

describe("mailbox send to a run", () => {
  test("a terminal run surfaces as 409, not a 500", async () => {
    const response = await sendTo(409, JSON.stringify({ code: "workflow_run_terminal" }));
    expect(response.status).toBe(409);
  });

  test("other trigger failures stay a server error", async () => {
    const response = await sendTo(500, "boom");
    expect(response.status).toBe(500);
  });
});
