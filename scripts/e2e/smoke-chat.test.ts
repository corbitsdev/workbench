// Smoke scenario 3/5 (CL-6004): chat round-trip. A workbench is created,
// a message is posted and read back with its content intact, and the
// workbench's invited-agent listing answers with the documented shape.
// This deliberately stops short of `chat.test.ts`'s full battery
// (mentions, read-state, multi-principal fan-out, agent invite) — it
// is a fast canary that the basic surface is alive, not a re-run of
// the deep suite. No workflow is deployed and no inference source is
// configured: the invitable-definitions listing is asserted only on
// its documented shape (an `items` array of `{id, name}`) rather than
// by exercising a live agent invite, so this scenario never needs a
// credential of any kind.

import { describe, expect, test } from "bun:test";

import { resetSchema, setupDatabase } from "../db-setup.ts";
import {
  api,
  createCleanupHarness,
  e2eDatabaseUrl,
  expectStatus,
  freePort,
  hop,
  provisionSidecar,
  startHub,
  startSidecar,
  type HubHandle,
} from "./harness.ts";

const { tempDir, track } = createCleanupHarness();

const databaseUrl = e2eDatabaseUrl();
if (databaseUrl === undefined) {
  console.warn(
    "smoke-chat: DATABASE_URL is not set; suite skipped. Set DATABASE_URL " +
      "(see .env.example) to run it; start Postgres with `docker compose -f docker-compose.test.yml up -d` so this skip " +
      "can never pass silently there.",
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

describe.skipIf(databaseUrl === undefined)("smoke: chat round-trip", () => {
  test("a posted message persists and the invited-agent listing has the documented shape", async () => {
    const url = databaseUrl;
    if (url === undefined) throw new Error("unreachable: suite is skipped");

    await hop("database setup", async () => {
      await resetSchema(url);
      await setupDatabase(url);
    });

    const hubDataDir = await tempDir("e2e-smoke-chat-hub-data-");
    const sidecarDataDir = await tempDir("e2e-smoke-chat-sidecar-data-");

    const sidecarId = "sidecar-e2e-smoke-chat";
    const sidecarToken = crypto.randomUUID();
    await hop("sidecar provisioning", () =>
      provisionSidecar(url, sidecarId, sidecarToken),
    );

    const hub: HubHandle = await hop("hub boot", () =>
      startHub({
        databaseUrl: url,
        port: freePort(),
        sessionSecret: Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString("hex"),
        dataDir: hubDataDir,
      }),
    );
    track(hub);

    const sidecar = await hop("sidecar boot", () =>
      Promise.resolve(
        startSidecar({
          hubPort: Number(new URL(hub.baseUrl).port),
          sidecarId,
          token: sidecarToken,
          dataDir: sidecarDataDir,
        }),
      ),
    );
    track(sidecar);

    {
      const cookies = await hop("sign-up", async () => {
        const res = await api(hub.baseUrl, "POST", "/api/auth/sign-up/email", {
          name: "Chat Smoke Tester",
          email: `smoke-chat-${crypto.randomUUID()}@example.invalid`,
          password: `pw-${crypto.randomUUID()}`,
        });
        expectStatus("sign-up", res, 200);
        if (res.cookies.length === 0) {
          throw new Error("sign-up returned no session cookie");
        }
        return res.cookies;
      });

      const tenantId = await hop("tenant creation", async () => {
        const slug = `smokechat${crypto.randomUUID().slice(0, 8)}`;
        const res = await api(
          hub.baseUrl,
          "POST",
          "/api/tenants",
          { name: "Chat Smoke", slug },
          cookies,
        );
        expectStatus("create tenant", res, 201);
        return stringField(res.data, "id", "create tenant");
      });

      const workbenchId = await hop("workbench creation", async () => {
        // Launching a workbench boots its anchor instance in-process,
        // which needs the sidecar's dial-in to have completed; retry
        // through the transient 500 the same way chat.test.ts does.
        const deadline = Date.now() + 60_000;
        for (;;) {
          if (sidecar.exited()) {
            throw new Error(
              `sidecar exited before workbench creation; output:\n${sidecar.output()}`,
            );
          }
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/chat/workbenches`,
            { kind: "workbench", name: "Smoke Workbench" },
            cookies,
          );
          if (res.status !== 500) {
            expectStatus("create workbench", res, 201);
            return stringField(res.data, "id", "create workbench");
          }
          if (Date.now() > deadline) {
            throw new Error(
              `workbench never became launchable (hub kept answering 500): ${JSON.stringify(res.data)}\nsidecar output:\n${sidecar.output()}`,
            );
          }
          await Bun.sleep(1000);
        }
      });

      const messageText = `smoke message ${crypto.randomUUID()}`;
      await hop("post a message", async () => {
        // Workbench creation no longer waits for the sidecar's dial-in
        // (the hub defers the launch), so this first post is the first
        // call that needs a routable sidecar — retry through the 500
        // the wake path answers until the dial-in lands.
        const deadline = Date.now() + 60_000;
        for (;;) {
          const res = await api(
            hub.baseUrl,
            "POST",
            `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages`,
            { parts: [{ kind: "text", text: messageText }] },
            cookies,
          );
          if (res.status !== 500) {
            expectStatus("post message", res, 201);
            stringField(res.data, "id", "post message");
            return;
          }
          if (Date.now() > deadline) {
            throw new Error(
              `post message kept answering 500: ${JSON.stringify(res.data)}` +
                `\nsidecar output:\n${sidecar.output()}`,
            );
          }
          await Bun.sleep(1000);
        }
      });

      await hop("the message persists with its original content", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/messages`,
          undefined,
          cookies,
        );
        expectStatus("list messages", res, 200);
        const items = (
          res.data as {
            items: { parts: { kind: string; text?: string }[] }[];
          }
        ).items;
        const found = items.some((item) =>
          item.parts.some(
            (part) => part.kind === "text" && part.text === messageText,
          ),
        );
        if (!found) {
          throw new Error(
            `posted message not found in the workbench's timeline: ${JSON.stringify(items)}`,
          );
        }
      });

      await hop("the workbench is listed", async () => {
        const res = await api(
          hub.baseUrl,
          "GET",
          `/api/tenants/${tenantId}/chat/workbenches`,
          undefined,
          cookies,
        );
        expectStatus("list workbenches", res, 200);
        const items = (res.data as { items: { id: string }[] }).items;
        const found = items.some((item) => item.id === workbenchId);
        if (!found) {
          throw new Error(
            `created workbench missing from the workbench listing: ${JSON.stringify(items)}`,
          );
        }
      });

      await hop(
        "the invited-agent listing has the documented shape",
        async () => {
          const res = await api(
            hub.baseUrl,
            "GET",
            `/api/tenants/${tenantId}/chat/workbenches/${workbenchId}/invitable`,
            undefined,
            cookies,
          );
          expectStatus("list invitable definitions", res, 200);
          const body = res.data as { items: { id: string; name: string }[] };
          expect(Array.isArray(body.items)).toBe(true);
          // No workflow is deployed on this tenant, so any listed entries
          // are platform-provided definitions available by default; the
          // contract asserted here is the response shape (an `items`
          // array of `{id, name}`), not that the tenant deployed anything.
          for (const item of body.items) {
            expect(typeof item.id).toBe("string");
            expect(typeof item.name).toBe("string");
          }
        },
      );
    }
  }, 120_000);
});
