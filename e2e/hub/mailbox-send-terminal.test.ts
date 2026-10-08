// DB-gated: a terminal run's 409 must survive the real @corbits/mailbox
// mount, which awaits `deliver` with no catch of its own.
import { afterAll, expect, test } from "bun:test";
import { Hono } from "hono";
import { createDB } from "@intx/db";
import { principal, tenant } from "@intx/db/schema";
import {
  createInMemoryMailboxEventBus,
  createMailboxDb,
  mountMailbox,
  runMailboxMigrations,
  type MailboxDb,
} from "@corbits/mailbox";
import { captureMailboxRequest, createMailboxDeliver } from "../../apps/hub/src/mailbox-send";
import { e2eDatabaseUrl } from "../lib/database-url";
import { dbGate } from "../lib/db-gate";

const databaseUrl = e2eDatabaseUrl() ?? "";
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const close of closers) await close();
});

function dbConfigFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? 5432 : Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.replace(/^\//, ""),
  };
}

describeIfDb("mailbox send through the real mount", () => {
  async function sendToRun(triggerStatus: number, code: string) {
    const { db, close } = createMailboxDb(databaseUrl) as {
      db: MailboxDb;
      close: () => Promise<void>;
    };
    closers.push(close);
    await runMailboxMigrations(db);
    const { db: hubDb, close: closeHub } = createDB(dbConfigFromUrl(databaseUrl));
    closers.push(closeHub);
    const suffix = crypto.randomUUID().slice(0, 8);
    const tenantId = `tnt_term_${suffix}`;
    const principalId = `prn_term_${suffix}`;
    await hubDb.insert(tenant).values({
      id: tenantId,
      name: "Terminal Run Tenant",
      slug: `term-${suffix}`,
      domain: `term-${suffix}.test`,
    });
    await hubDb
      .insert(principal)
      .values({ id: principalId, tenantId, kind: "user", refId: principalId, status: "active" });
    const app = new Hono();
    app.use("/tenants/:tenantId/mailbox/me/inbox/send", captureMailboxRequest());
    const mailboxApp = new Hono();
    mailboxApp.use("/me/inbox/send", captureMailboxRequest());
    mountMailbox(mailboxApp, {
      db,
      bus: createInMemoryMailboxEventBus(),
      resolvePrincipal: () => ({ tenantId, principalId }),
      senderAddressFor: () => "person@term.test",
      deliver: createMailboxDeliver({
        app: {
          request: () =>
            Response.json({ error: { code, message: "x" } }, { status: triggerStatus }),
        },
        persistMail: () => Promise.resolve(),
      }),
    });
    app.route("/tenants/:tenantId/mailbox", mailboxApp);
    return app.request(`/tenants/${tenantId}/mailbox/me/inbox/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: ["run_abc@term.test"], subject: "hi", body: "hello" }),
    });
  }

  test("workflow_run_terminal answers 409 with its code", async () => {
    const response = await sendToRun(409, "workflow_run_terminal");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "workflow_run_terminal" } });
  });

  test("deployment_unreachable stays a 500", async () => {
    const response = await sendToRun(409, "deployment_unreachable");
    expect(response.status).toBe(500);
  });
});
