import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import { createApprovalNotificationsRouter } from "./approval-notifications";
import {
  createApprovalsEventBus,
  type ApprovalEvent,
} from "../lib/approvals-events";

type ResBody = { error: string };

const PRINCIPAL = {
  id: "prn-1",
  tenantId: "tenant-1",
  kind: "user",
  refId: "user-1",
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeMockDb(overrides: Record<string, any> = {}) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock
  const base: any = {
    query: {
      principal: {
        findFirst: mock(() => Promise.resolve(undefined)),
      },
    },
    ...overrides,
  };
  return base;
}

function buildApp(
  db: ReturnType<typeof makeMockDb>,
  userId = "user-1",
  bus = createApprovalsEventBus(),
) {
  const parent = new Hono<{ Variables: { userId: string } }>();
  parent.use("*", async (c, next) => {
    c.set("userId", userId);
    await next();
  });
  parent.route("/", createApprovalNotificationsRouter(db, bus));
  return parent;
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<string> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("stream read timed out")), ms),
  );
  const { value } = await Promise.race([reader.read(), timeout]);
  return value ? new TextDecoder().decode(value) : "";
}

describe("GET /tenants/:tenantId/approvals/stream", () => {
  it("returns 403 for a caller who is not a tenant member", async () => {
    const db = makeMockDb(); // principal.findFirst → undefined
    const app = buildApp(db);
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/stream"),
    );
    expect(res.status).toBe(403);
    const json = (await res.json()) as ResBody;
    expect(json.error).toContain("Forbidden");
  });

  it("streams a published change frame to a member and unsubscribes on abort", async () => {
    const db = makeMockDb();
    db.query.principal.findFirst = mock(() => Promise.resolve(PRINCIPAL));

    // Wrap a real bus so the test can observe that abort tears the subscription
    // down (the bus itself exposes no listener count).
    const realBus = createApprovalsEventBus();
    let subscribed = false;
    let unsubscribed = false;
    const bus = {
      publish: (event: ApprovalEvent) => realBus.publish(event),
      subscribe: (tenantId: string, listener: (e: ApprovalEvent) => void) => {
        const off = realBus.subscribe(tenantId, listener);
        subscribed = true;
        return () => {
          unsubscribed = true;
          off();
        };
      },
    };

    const app = buildApp(db, "user-1", bus);
    const controller = new AbortController();
    const res = await app.fetch(
      new Request("http://localhost/tenants/tenant-1/approvals/stream", {
        signal: controller.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader =
      res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    // Wait until the streamSSE callback has actually registered its bus
    // subscription before publishing, rather than a fixed sleep — a published
    // event before subscribe would be lost, and a fixed delay flakes under load.
    for (let i = 0; i < 100 && !subscribed; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(subscribed).toBe(true);
    bus.publish({ tenantId: "tenant-1", sessionId: null, kind: "created" });

    const frame = await readWithTimeout(reader, 1000);
    expect(frame).toContain("event: approvals");
    // Parse the frame's data line and assert the payload is EXACTLY the change
    // notification — no approval rows or tool-call arguments leak onto the wire.
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    const payload = JSON.parse(dataLine!.replace(/^data:\s*/, "")) as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      tenantId: "tenant-1",
      sessionId: null,
      kind: "created",
    });
    expect(Object.keys(payload).sort()).toEqual([
      "kind",
      "sessionId",
      "tenantId",
    ]);

    await reader.cancel().catch(() => {});
    controller.abort();
    for (let i = 0; i < 50 && !unsubscribed; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(unsubscribed).toBe(true);
  });
});
