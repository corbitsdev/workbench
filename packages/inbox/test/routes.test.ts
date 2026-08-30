// Route-level tests for the parts of `GET /` that reject before touching the
// database — the cursor/filter cross-check (CL-7206) chiefly. `db` is a
// stub that throws on any call, which is itself the assertion that a
// rejected request never reaches the mailbox store.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { TenantEnv } from "@intx/hub-api";
import {
  createInMemoryMailboxEventBus,
  type MailboxDb,
} from "@corbits/mailbox";
import { createInboxRoutes } from "../src/routes";

const TENANT = { id: "tnt_1" };
const PRINCIPAL = { id: "prn_1" };

function neverCalledDb(): MailboxDb {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("db should not be reached on a rejected request");
      },
    },
  ) as MailboxDb;
}

function mount(): Hono<TenantEnv> {
  const routes = createInboxRoutes({
    db: neverCalledDb(),
    bus: createInMemoryMailboxEventBus(),
  });
  const app = new Hono<TenantEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", PRINCIPAL as never);
    await next();
  });
  app.route("/", routes);
  return app;
}

describe("GET / cursor/filter cross-check", () => {
  test("a cursor minted under ?group=action is rejected when replayed under ?group=mention", async () => {
    const app = mount();
    // Minted the same way `listUserMailbox` mints one: base64url JSON with
    // view/sort/filter embedded, filter canonicalized to `classification=action`.
    const payload = {
      createdAt: "2026-01-01T00:00:00.000000Z",
      id: "msg_1",
      view: "all",
      sort: "date",
      filter: "classification=action",
    };
    const cursor = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const response = await app.request(
      `/?group=mention&cursor=${encodeURIComponent(cursor)}`,
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("cursor does not match inbox filter");
  });

  test("a well-formed cursor with no query params is malformed-rejected without a filter mismatch masking it", async () => {
    const app = mount();
    const response = await app.request("/?cursor=not-valid-base64url!!!");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("malformed cursor");
  });
});
