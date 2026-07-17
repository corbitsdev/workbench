import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import {
  createMailWakeMiddleware,
  registerUndeliveredMailWake,
} from "./mail-wake";

describe("createMailWakeMiddleware", () => {
  function buildApp(wake: (instanceId: string) => Promise<void>) {
    const order: string[] = [];
    const app = new Hono();
    app.use("/instances/:instanceId/mail", createMailWakeMiddleware(wake));
    app.all("/instances/:instanceId/mail", (c) => {
      order.push("route");
      return c.json({ ok: true });
    });
    return { app, order };
  }

  test("wakes the instance and awaits the wake BEFORE the mail route runs", async () => {
    const order: string[] = [];
    const wake = mock(async (instanceId: string) => {
      // Force async so a fire-and-forget (non-awaited) wake would let the
      // route run first and fail the ordering assertion below.
      await Promise.resolve();
      order.push(`wake:${instanceId}`);
    });
    const app = new Hono();
    app.use("/instances/:instanceId/mail", createMailWakeMiddleware(wake));
    app.post("/instances/:instanceId/mail", (c) => {
      order.push("route");
      return c.json({ ok: true });
    });

    const res = await app.request("/instances/ins-1/mail", { method: "POST" });
    expect(res.status).toBe(200);
    expect(order).toEqual(["wake:ins-1", "route"]);
  });

  test("does not wake on GET (mail-list polling shares the path)", async () => {
    const wake = mock(() => Promise.resolve());
    const { app, order } = buildApp(wake);

    const res = await app.request("/instances/ins-1/mail", { method: "GET" });
    expect(res.status).toBe(200);
    expect(order).toEqual(["route"]);
    expect(wake).not.toHaveBeenCalled();
  });

  test("a wake failure is swallowed and the mail route still runs", async () => {
    const wake = mock(() => Promise.reject(new Error("launch exploded")));
    const { app, order } = buildApp(wake);

    const res = await app.request("/instances/ins-1/mail", { method: "POST" });
    expect(res.status).toBe(200);
    expect(order).toEqual(["route"]);
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

describe("registerUndeliveredMailWake", () => {
  type UndeliveredHandler = (event: {
    rawMessage: string;
    recipients: string[];
  }) => void;

  function fakeDb(rowsByAddress: Record<string, string>) {
    // Minimal drizzle select-chain stand-in: resolves the instance id for a
    // known address, [] otherwise. The final `.limit()` returns the rows.
    let requestedAddress = "";
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => {
              const id = rowsByAddress[requestedAddress];
              return Promise.resolve(id === undefined ? [] : [{ id }]);
            },
          }),
        }),
      }),
      // Test hook: drizzle's eq() captures the address opaquely, so the fake
      // records it out of band before each emit.
      setAddress(address: string) {
        requestedAddress = address;
      },
    };
  }

  function setup(opts: {
    rowsByAddress: Record<string, string>;
    wake?: (instanceId: string) => Promise<void>;
    routeMail?: (address: string, raw: string) => boolean;
  }) {
    const db = fakeDb(opts.rowsByAddress);
    const wake = mock(opts.wake ?? (() => Promise.resolve()));
    const routeMail = mock(opts.routeMail ?? (() => true));
    let handler: UndeliveredHandler | undefined;
    const unsubscribe = mock(() => {});
    registerUndeliveredMailWake({
      db: db as never,
      wake,
      onUndelivered: (h) => {
        handler = h;
        return unsubscribe;
      },
      routeMail,
    });
    if (handler === undefined) throw new Error("handler not registered");
    return { db, wake, routeMail, emit: handler };
  }

  async function settle(): Promise<void> {
    // The handler fires wake-and-redeliver fire-and-forget; drain microtasks.
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  }

  test("wakes a known instance and re-delivers the mail to its address", async () => {
    const { db, wake, routeMail, emit } = setup({
      rowsByAddress: { "ins-oat@wf.localhost": "ins-oat" },
    });

    db.setAddress("ins-oat@wf.localhost");
    emit({ rawMessage: "raw-b64", recipients: ["ins-oat@wf.localhost"] });
    await settle();

    expect(wake).toHaveBeenCalledWith("ins-oat");
    expect(routeMail).toHaveBeenCalledWith("ins-oat@wf.localhost", "raw-b64");
  });

  test("re-delivery happens AFTER the wake resolves", async () => {
    const order: string[] = [];
    const { db, emit } = setup({
      rowsByAddress: { "ins-oat@wf.localhost": "ins-oat" },
      wake: async () => {
        await Promise.resolve();
        order.push("wake");
      },
      routeMail: () => {
        order.push("routeMail");
        return true;
      },
    });

    db.setAddress("ins-oat@wf.localhost");
    emit({ rawMessage: "raw", recipients: ["ins-oat@wf.localhost"] });
    await settle();

    expect(order).toEqual(["wake", "routeMail"]);
  });

  test("ignores a recipient with no agent-instance row (external/workflow address)", async () => {
    const { db, wake, routeMail, emit } = setup({ rowsByAddress: {} });

    db.setAddress("someone@example.com");
    emit({ rawMessage: "raw", recipients: ["someone@example.com"] });
    await settle();

    expect(wake).not.toHaveBeenCalled();
    expect(routeMail).not.toHaveBeenCalled();
  });

  test("a wake failure is contained — no unhandled rejection, no re-delivery attempt", async () => {
    const { db, routeMail, emit } = setup({
      rowsByAddress: { "ins-oat@wf.localhost": "ins-oat" },
      wake: () => Promise.reject(new Error("launch exploded")),
    });

    db.setAddress("ins-oat@wf.localhost");
    emit({ rawMessage: "raw", recipients: ["ins-oat@wf.localhost"] });
    await settle();

    expect(routeMail).not.toHaveBeenCalled();
  });
});
