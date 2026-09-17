// Exercises the hub's own composition: the stock platform routes answer,
// and a Corbits mount (mailbox) sits inside the native tenant middleware
// rather than replacing it. Platform behavior behind stock routes belongs
// to @intx/hub-api and is not re-proven here. Booting the hub runs package
// migrations, so a reachable DATABASE_URL is required and the suite skips
// without one.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dbGate } from "../../../test/db-gate";

const databaseUrl = process.env["DATABASE_URL"] ?? "";
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const root = mktempHubDataDir();
function mktempHubDataDir(): string {
  return mkdtempSync(path.join(tmpdir(), "hub-composition-"));
}

process.env["HUB_DATA_DIR"] = root;
process.env["CREDENTIAL_ENCRYPTION_KEY"] ??= "0".repeat(64);
process.env["PRINCIPAL_KEY_ENCRYPTION_KEY"] ??= "1".repeat(64);
process.env["HUB_ALLOW_GIT_INSIDE_WORK_TREE"] = "1";
if (databaseUrl !== "") {
  const url = new URL(databaseUrl);
  process.env["DB_HOST"] = url.hostname;
  process.env["DB_PORT"] = url.port === "" ? "5432" : url.port;
  process.env["DB_USER"] = decodeURIComponent(url.username);
  process.env["DB_PASSWORD"] = decodeURIComponent(url.password);
  process.env["DB_NAME"] = url.pathname.replace(/^\//, "");
}

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
  rmSync(root, { recursive: true, force: true });
});

describeIfDb("boot", () => {
  test("serves stock platform routes", async () => {
    const { createHubServer } = await import("../src/server");
    const opts = await createHubServer();

    const status = await opts.fetch(new Request("http://localhost/status"));
    expect(status.status).toBe(200);

    const me = await opts.fetch(new Request("http://localhost/api/me/principals"));
    expect(me.status).toBe(401);
  });

  test("a Corbits mount (mailbox) sits inside the native tenant middleware", async () => {
    const { createHubServer } = await import("../src/server");
    const opts = await createHubServer();

    // Anonymous request to a Corbits-mounted route: the platform's tenant
    // middleware answers 401 before the mailbox library's own handler runs.
    const gated = await opts.fetch(
      new Request("http://localhost/api/tenants/some-tenant/mailbox/me/inbox"),
    );
    expect(gated.status).toBe(401);
  });
});
