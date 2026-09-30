// Exercises the hub's own composition: the stock platform routes answer,
// and a Corbits mount (mailbox) sits inside the native tenant middleware
// rather than replacing it. Platform behavior behind stock routes belongs
// to @intx/hub-api and is not re-proven here. Booting the hub runs package
// migrations, so a reachable DATABASE_URL is required and the suite skips
// without one.

import { expect, test } from "bun:test";
import { dbGate } from "../lib/db-gate";
import { bootHub } from "../lib/hub";

const describeIfDb = dbGate(process.env["DATABASE_URL"] ?? "", import.meta.path);

describeIfDb("boot", () => {
  const first = bootHub();
  const second = bootHub();

  test("serves stock platform routes", async () => {
    const opts = first();

    const status = await opts.fetch(new Request("http://localhost/status"));
    expect(status.status).toBe(200);

    const me = await opts.fetch(new Request("http://localhost/api/me/principals"));
    expect(me.status).toBe(401);
  });

  test("a Corbits mount (mailbox) sits inside the native tenant middleware", async () => {
    const opts = second();

    // Anonymous request to a Corbits-mounted route: the platform's tenant
    // middleware answers 401 before the mailbox library's own handler runs.
    const gated = await opts.fetch(
      new Request("http://localhost/api/tenants/some-tenant/mailbox/me/inbox"),
    );
    expect(gated.status).toBe(401);
  });
});
