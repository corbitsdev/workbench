// The Routines page's webhook-triggers client: request paths/bodies,
// boundary parsing, and the secret-never-persisted-client-side contract
// (only create/rotate responses carry it, and only because the hub's
// own routes only ever put it there — see
// packages/webhook-triggers/src/management-routes.ts).

import { afterEach, describe, expect, test } from "bun:test";

import { ApiQueryError } from "@corbits/api-query";
import {
  createWebhookTrigger,
  deleteWebhookTrigger,
  getWebhookTrigger,
  listWebhookTriggers,
  rotateWebhookTriggerSecret,
  sampleWebhookPayload,
  setWebhookTriggerEnabled,
  webhookTriggerUrl,
} from "../src/webhook-triggers-api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = {
  readonly path: string;
  readonly init: RequestInit | undefined;
};

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push({ path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const triggerFixture = {
  id: "wht_1",
  tenantId: "tnt_1",
  name: "Support digest",
  workflowDefinitionId: "wfd_1",
  inputTemplate: "New webhook delivery.",
  enabled: true,
  createdBy: "usr_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastFiredAt: null,
};

describe("listWebhookTriggers", () => {
  test("hits the tenant-scoped list route and unwraps items", async () => {
    const calls = stubFetch(() => json({ items: [triggerFixture] }));
    const items = await listWebhookTriggers("tnt_1");
    expect(items).toEqual([triggerFixture]);
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/webhook-triggers");
  });
});

describe("getWebhookTrigger", () => {
  test("hits the id route", async () => {
    const calls = stubFetch(() => json(triggerFixture));
    const item = await getWebhookTrigger("tnt_1", "wht_1");
    expect(item).toEqual(triggerFixture);
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1/webhook-triggers/wht_1");
  });
});

describe("createWebhookTrigger", () => {
  test("POSTs the input and returns the one-time secret", async () => {
    const calls = stubFetch(() =>
      json({ ...triggerFixture, secret: "generated-secret" }, 201),
    );
    const result = await createWebhookTrigger("tnt_1", {
      name: "Support digest",
      workflowDefinitionId: "wfd_1",
      inputTemplate: "New webhook delivery.",
    });
    expect(result.secret).toBe("generated-secret");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Support digest",
      workflowDefinitionId: "wfd_1",
      inputTemplate: "New webhook delivery.",
    });
  });

  test("rejects a response missing the secret field", async () => {
    stubFetch(() => json(triggerFixture, 201));
    await expect(
      createWebhookTrigger("tnt_1", {
        name: "x",
        workflowDefinitionId: "wfd_1",
        inputTemplate: "x",
      }),
    ).rejects.toBeInstanceOf(ApiQueryError);
  });
});

describe("rotateWebhookTriggerSecret", () => {
  test("POSTs to the rotate route and returns the new one-time secret", async () => {
    const calls = stubFetch(() =>
      json({ ...triggerFixture, secret: "rotated-secret" }),
    );
    const result = await rotateWebhookTriggerSecret("tnt_1", "wht_1");
    expect(result.secret).toBe("rotated-secret");
    expect(calls[0]?.path).toBe(
      "/api/tenants/tnt_1/webhook-triggers/wht_1/rotate-secret",
    );
    expect(calls[0]?.init?.method).toBe("POST");
  });
});

describe("setWebhookTriggerEnabled", () => {
  test("POSTs the enabled flag", async () => {
    const calls = stubFetch(() => json({ ...triggerFixture, enabled: false }));
    const result = await setWebhookTriggerEnabled("tnt_1", "wht_1", false);
    expect(result.enabled).toBe(false);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      enabled: false,
    });
  });
});

describe("deleteWebhookTrigger", () => {
  test("DELETEs the trigger", async () => {
    const calls = stubFetch(() => new Response(null, { status: 204 }));
    await deleteWebhookTrigger("tnt_1", "wht_1");
    expect(calls[0]?.init?.method).toBe("DELETE");
  });
});

describe("error handling", () => {
  test("a 404 surfaces the hub's error message", async () => {
    stubFetch(() =>
      json({ error: { code: "not_found", message: "trigger not found" } }, 404),
    );
    await expect(getWebhookTrigger("tnt_1", "missing")).rejects.toThrow(
      /trigger not found/,
    );
  });

  test("a 401 reports not signed in", async () => {
    stubFetch(() => new Response(null, { status: 401 }));
    let caught: unknown;
    try {
      await listWebhookTriggers("tnt_1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiQueryError);
    expect((caught as ApiQueryError).status).toBe(401);
  });
});

describe("webhookTriggerUrl", () => {
  test("builds the ingress path for a trigger id", () => {
    expect(webhookTriggerUrl("wht_1")).toContain("/api/webhooks/wht_1");
  });
});

describe("sampleWebhookPayload", () => {
  test("is valid, non-empty JSON", () => {
    const parsed: unknown = JSON.parse(sampleWebhookPayload());
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
  });
});
