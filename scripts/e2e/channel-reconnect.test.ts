// CL-6067: a workbench must never surface a stuck disconnected state to
// the user after a hub restart — the prior hub process's in-memory
// routing (which run addresses are live) is gone, but the workbench's
// own row in Postgres is not, and a message sent after the restart
// must still reach the workbench's anchor instance with no manual
// intervention (no re-invite, no re-launch, no user-visible error).
//
// This is the regression-shaped e2e the ticket asks for: launch a
// workbench against a real hub+sidecar, stop the hub process, start a
// fresh hub process against the same database and port (mirroring a
// process restart, not a fresh deploy), and prove a message sent
// afterward is accepted and shows up on the timeline with no action
// beyond the ordinary send call.
//
// Deterministic — no credentials, no real inference, no API keys.

import { beforeAll, describe, expect, test } from "bun:test";

import { seedCatalog } from "../../packages/seeding/src/index.ts";
import {
  createHubAPI,
  type ApiCall,
} from "../../packages/hub-api-client/src/index.ts";
import type { Part } from "../../packages/chat/src/index.ts";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  provisionSidecar,
  startHub,
  startSidecar,
  type ApiResult,
  type HubHandle,
  type SpawnedApp,
} from "./harness.ts";

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "workbench-reconnect e2e: DATABASE_URL is not set; suite skipped. Set " +
      "DATABASE_URL (see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` " +
      "so this skip can never pass silently there.",
  );
}

function stringField(data: unknown, field: string, what: string): string {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(
    `${what}: missing string field "${field}": ${JSON.stringify(data)}`,
  );
}

function arrayField(data: unknown, field: string, what: string): unknown[] {
  if (typeof data === "object" && data !== null && field in data) {
    const value = (data as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  throw new Error(
    `${what}: missing array field "${field}": ${JSON.stringify(data)}`,
  );
}

type ListedMessage = { id: string; parts: Part[] };

const textPart = (text: string): Part[] => [{ kind: "text", text }];

const { tempDir, track } = createCleanupHarness();

describe.skipIf(databaseUrl === undefined)("workbench reconnect e2e", () => {
  let hubPort: number;
  let sessionSecret: string;
  let hub: HubHandle;
  let sidecar: SpawnedApp;
  let api: ApiCall;
  let cookies: string[];
  let tenantId: string;
  let workbenchId: string;
  let dbUrl: string;

  beforeAll(async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");
    dbUrl = url;

    await resetSchema(url);
    const report = await setupDatabase(url);
    expect(report.action).toBe("migrated");
    expect(report.migrations).toBeGreaterThan(0);

    const sidecarId = "workbench-reconnect-e2e-sidecar";
    const sidecarToken = crypto.randomUUID();
    await provisionSidecar(url, sidecarId, sidecarToken);

    hubPort = freePort();
    sessionSecret = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("hex");

    hub = await startHub({
      databaseUrl: url,
      port: hubPort,
      sessionSecret,
      dataDir: await tempDir("e2e-workbench-reconnect-hub-data-"),
    });
    track(hub);

    sidecar = startSidecar({
      hubPort,
      sidecarId,
      token: sidecarToken,
      dataDir: await tempDir("e2e-workbench-reconnect-sidecar-data-"),
    });
    track(sidecar);

    api = createHubAPI(hub.baseUrl);

    const email = `workbench-reconnect-e2e-${crypto.randomUUID()}@example.invalid`;
    const password = `pw-${crypto.randomUUID()}`;
    const signedUp = await api("POST", "/api/auth/sign-up/email", {
      name: "Workbench Reconnect Tester",
      email,
      password,
    });
    expectStatus("sign up", signedUp, 200);
    cookies = signedUp.cookies;

    const slug = `chreconn${crypto.randomUUID().slice(0, 8)}`;
    const created = await api(
      "POST",
      "/api/tenants",
      { name: "Workbench Reconnect E2E", slug },
      cookies,
    );
    expectStatus("create tenant", created, 201);
    tenantId = stringField(created.data, "id", "create tenant");

    // A workbench host's folded launch pins a real inference source chain
    // against the tenant catalog before it will launch at all, exactly
    // as chat.test.ts's own boot does — the placeholder key is never
    // used to call a model.
    await seedCatalog({
      api,
      cookies,
      tenantId,
      placeholderCredential: true,
      log: () => undefined,
    });
  }, 120_000);

  async function createWorkbench(
    body: Record<string, unknown>,
  ): Promise<ApiResult> {
    const deadline = Date.now() + 60_000;
    let res: ApiResult;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited before workbench creation; output:\n${sidecar.output()}`,
        );
      }
      res = await api(
        "POST",
        `/api/tenants/${tenantId}/chat/workbenches`,
        body,
        cookies,
      );
      if (res.status !== 500) break;
      if (Date.now() > deadline) {
        throw new Error(
          `workbench never became launchable (hub kept answering 500): ` +
            `${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
        );
      }
      await Bun.sleep(1000);
    }
    return res;
  }

  async function postMessage(text: string): Promise<ApiResult> {
    return api(
      "POST",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages`,
      { parts: textPart(text) },
      cookies,
    );
  }

  async function listMessages(): Promise<ListedMessage[]> {
    const res = await api(
      "GET",
      `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages`,
      undefined,
      cookies,
    );
    expectStatus("list messages", res, 200);
    return arrayField(
      res.data,
      "items",
      "list messages",
    ) as unknown as ListedMessage[];
  }

  test("workbench creation launches the anchor", async () => {
    const res = await createWorkbench({
      kind: "workbench",
      name: "reconnect-demo",
    });
    expectStatus("create workbench", res, 201);
    workbenchId = stringField(res.data, "id", "create workbench");
  }, 90_000);

  test("a message before the restart reaches the timeline", async () => {
    const before = `before restart ${crypto.randomUUID()}`;
    // Workbench creation no longer waits for the sidecar's dial-in (the
    // hub defers the launch), so this first post is the first call that
    // needs a routable sidecar — retry through the 500 the wake path
    // answers until the dial-in lands.
    let posted = await postMessage(before);
    const deadline = Date.now() + 60_000;
    while (posted.status === 500 && Date.now() < deadline) {
      await Bun.sleep(1000);
      posted = await postMessage(before);
    }
    expectStatus("post message before restart", posted, 201);

    const items = await listMessages();
    const texts = items.flatMap((item) =>
      item.parts
        .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
        .map((p) => p.text),
    );
    expect(texts).toContain(before);
  }, 90_000);

  test("a message sent after a hub restart is accepted and answered with no manual intervention", async () => {
    // Stop the hub process — every in-memory fact it held (which run
    // addresses are currently routable) is gone — and start a fresh
    // hub process on the same port against the same database, exactly
    // as a real restart looks from the sidecar's and the browser's
    // side: same DB rows, same session cookie, new process. The port
    // must stay the same — the sidecar's own `HUB_WS_URL` is fixed at
    // its boot and is never reconfigured here (only the hub restarts),
    // so a different port would leave the sidecar dialing a hub that
    // is no longer there.
    await hub.stop();

    const restarted = await startHub({
      databaseUrl: dbUrl,
      port: hubPort,
      sessionSecret,
      dataDir: await tempDir("e2e-workbench-reconnect-hub-data-restart-"),
    });
    track(restarted);
    hub = restarted;
    api = createHubAPI(hub.baseUrl);

    // The sidecar's own reconnect scheduler (@intx/hub-agent) re-dials
    // the fresh hub process on its own; this suite only needs to wait
    // for a send to stop 502-ing the way `createWorkbench` already does
    // for a not-yet-connected sidecar, never driving the sidecar
    // itself.
    const after = `after restart ${crypto.randomUUID()}`;
    const deadline = Date.now() + 180_000;
    let posted: ApiResult;
    for (;;) {
      if (sidecar.exited()) {
        throw new Error(
          `sidecar exited after hub restart; output:\n${sidecar.output()}`,
        );
      }
      posted = await postMessage(after);
      if (posted.status === 201) break;
      if (Date.now() > deadline) {
        throw new Error(
          `message after hub restart never accepted: status=${posted.status} ` +
            `${JSON.stringify(posted.data)}\nsidecar output:\n${sidecar.output()}` +
            `\nhub output:\n${hub.output()}`,
        );
      }
      await Bun.sleep(1000);
    }

    const items = await listMessages();
    const texts = items.flatMap((item) =>
      item.parts
        .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
        .map((p) => p.text),
    );
    expect(texts).toContain(after);
  }, 200_000);
});
