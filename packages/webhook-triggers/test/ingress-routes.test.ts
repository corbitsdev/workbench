// Exercises `createWebhookIngressRoutes`' HTTP surface: signature
// verification (valid/invalid/missing), unknown/disabled-trigger
// handling, and payload parsing — with a fake `launch` seam so no
// database or folded-run launch machinery is involved. This is the
// trust-boundary route: no session, no tenant middleware.
import { describe, expect, test } from "bun:test";
import { createWebhookIngressRoutes } from "../src/ingress-routes";
import { signPayload, WEBHOOK_SIGNATURE_HEADER } from "../src/signature";
import { createInMemoryWebhookTriggerStore } from "./test-support";

async function seedTrigger(
  store: ReturnType<typeof createInMemoryWebhookTriggerStore>,
  overrides: { enabled?: boolean } = {},
) {
  const row = await store.create({
    id: "ins_trigger1",
    tenantId: "tnt_1",
    name: "Granola",
    workflowDefinitionId: "def_1",
    inputTemplate: "{{note.title}}",
    secret: "s3cr3t",
    createdBy: "prn_alice",
  });
  if (overrides.enabled === false) {
    await store.setEnabled("tnt_1", row.id, false);
  }
  return row;
}

function buildApp(
  launch: Parameters<
    typeof createWebhookIngressRoutes
  >[0]["launch"] = async () => ({
    instanceId: "ins_x",
    triggerAddress: "ins_x@acme.example",
  }),
) {
  const store = createInMemoryWebhookTriggerStore();
  const app = createWebhookIngressRoutes({ store, launch });
  return { app, store };
}

describe("POST /:triggerId", () => {
  test("launches on a validly signed payload", async () => {
    let launchedWith: unknown;
    const { app, store } = buildApp(async (_trigger, payload) => {
      launchedWith = payload;
      return { instanceId: "ins_new", triggerAddress: "ins_new@acme.example" };
    });
    await seedTrigger(store);

    const body = JSON.stringify({ note: { title: "Q3 planning" } });
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", body),
      },
      body,
    });

    expect(response.status).toBe(202);
    expect(launchedWith).toEqual({ note: { title: "Q3 planning" } });
    const trigger = await store.getById("ins_trigger1");
    expect(trigger?.lastFiredAt).not.toBeNull();
  });

  test("rejects a missing signature header", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(401);
  });

  test("rejects a signature computed with the wrong secret", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const body = "{}";
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [WEBHOOK_SIGNATURE_HEADER]: signPayload("wrong-secret", body),
      },
      body,
    });

    expect(response.status).toBe(401);
  });

  test("404s for an unknown trigger id without leaking whether it ever existed", async () => {
    const { app } = buildApp();
    const response = await app.request("/no-such-trigger", {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  test("403s for a disabled trigger even with a valid signature", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store, { enabled: false });

    const body = "{}";
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: { [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", body) },
      body,
    });

    expect(response.status).toBe(403);
  });

  test("400s on a validly signed but non-JSON body", async () => {
    const { app, store } = buildApp();
    await seedTrigger(store);

    const body = "not json";
    const response = await app.request("/ins_trigger1", {
      method: "POST",
      headers: { [WEBHOOK_SIGNATURE_HEADER]: signPayload("s3cr3t", body) },
      body,
    });

    expect(response.status).toBe(400);
  });
});
