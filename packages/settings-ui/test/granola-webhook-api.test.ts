// The Granola webhook card's seam to `@corbits/webhook-triggers`' and
// `@corbits/routines`' HTTP routes — mirrors `apps/web/src/routines-api.ts`
// and `apps/web/src/webhook-triggers-api.ts`'s conventions (tenant-scoped
// requests, arktype at the boundary) without depending on either app-side
// module, since `packages/settings-ui` never imports from `apps/*`.

import { afterEach, describe, expect, test } from "bun:test";

import {
  bindRoutineWebhookTrigger,
  createGranolaWebhookTrigger,
  GranolaWebhookApiError,
  listGranolaRoutines,
  listGranolaWebhookTriggers,
  listGranolaWorkflowDefinitions,
  rotateGranolaWebhookTriggerSecret,
  sampleGranolaWebhookPayload,
  webhookTriggerUrl,
} from "../src/granola-webhook-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("listGranolaWebhookTriggers", () => {
  test("requests the tenant's webhook-triggers listing and unwraps items", async () => {
    let requestedPath = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedPath = String(input);
      return jsonResponse(200, {
        items: [
          {
            id: "wht_1",
            tenantId: "ten_1",
            name: "granola-call webhook",
            workflowDefinitionId: "def_1",
            inputTemplate: "New webhook delivery.",
            enabled: true,
            createdBy: "user_1",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastFiredAt: null,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const triggers = await listGranolaWebhookTriggers("ten_1");
    expect(requestedPath).toBe("/api/tenants/ten_1/webhook-triggers");
    expect(triggers).toMatchObject([
      {
        id: "wht_1",
        name: "granola-call webhook",
        workflowDefinitionId: "def_1",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastFiredAt: null,
      },
    ]);
  });

  test("throws GranolaWebhookApiError on a non-2xx response", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(500, {
        error: { code: "boom", message: "broke" },
      })) as unknown as typeof fetch;
    await expect(listGranolaWebhookTriggers("ten_1")).rejects.toBeInstanceOf(
      GranolaWebhookApiError,
    );
  });
});

describe("createGranolaWebhookTrigger", () => {
  test("posts name + workflowDefinitionId and returns the once-shown secret", async () => {
    let requestedPath = "";
    let requestedBody: unknown;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestedPath = String(input);
      requestedBody =
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse(201, {
        id: "wht_2",
        tenantId: "ten_1",
        name: "granola-call webhook",
        workflowDefinitionId: "def_1",
        inputTemplate: "New webhook delivery.",
        enabled: true,
        createdBy: "user_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastFiredAt: null,
        secret: "sec_fresh",
      });
    }) as unknown as typeof fetch;

    const created = await createGranolaWebhookTrigger(
      "ten_1",
      "def_1",
      "granola-call webhook",
    );
    expect(requestedPath).toBe("/api/tenants/ten_1/webhook-triggers");
    expect(requestedBody).toEqual({
      name: "granola-call webhook",
      workflowDefinitionId: "def_1",
      inputTemplate: "New webhook delivery.",
    });
    expect(created.id).toBe("wht_2");
    expect(created.secret).toBe("sec_fresh");
  });
});

describe("rotateGranolaWebhookTriggerSecret", () => {
  test("posts to the rotate-secret route and returns a new secret", async () => {
    let requestedPath = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedPath = String(input);
      return jsonResponse(200, {
        id: "wht_2",
        tenantId: "ten_1",
        name: "granola-call webhook",
        workflowDefinitionId: "def_1",
        inputTemplate: "New webhook delivery.",
        enabled: true,
        createdBy: "user_1",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastFiredAt: "2026-01-02T00:00:00.000Z",
        secret: "sec_rotated",
      });
    }) as unknown as typeof fetch;

    const rotated = await rotateGranolaWebhookTriggerSecret("ten_1", "wht_2");
    expect(requestedPath).toBe(
      "/api/tenants/ten_1/webhook-triggers/wht_2/rotate-secret",
    );
    expect(rotated.secret).toBe("sec_rotated");
  });
});

describe("listGranolaRoutines", () => {
  test("requests the tenant's routines and keeps only id, name, definitionId, trigger", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(200, {
        items: [
          {
            id: "rt_1",
            name: "Granola calls",
            definitionId: "def_1",
            trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
            scope: "bench",
            input: {},
            enabled: true,
            deliveryChannelId: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      })) as unknown as typeof fetch;

    const routines = await listGranolaRoutines("ten_1");
    expect(routines).toMatchObject([
      {
        id: "rt_1",
        name: "Granola calls",
        definitionId: "def_1",
        trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
      },
    ]);
  });
});

describe("listGranolaWorkflowDefinitions", () => {
  test("returns id/name pairs from the workflow-definitions listing", async () => {
    let requestedPath = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedPath = String(input);
      return jsonResponse(200, {
        data: [{ id: "def_1", name: "granola-call", status: "active" }],
        nextCursor: null,
      });
    }) as unknown as typeof fetch;

    const definitions = await listGranolaWorkflowDefinitions("ten_1");
    expect(requestedPath).toContain("/api/tenants/ten_1/workflows/definitions");
    expect(definitions).toEqual([{ id: "def_1", name: "granola-call" }]);
  });
});

describe("bindRoutineWebhookTrigger", () => {
  test("PATCHes the routine's trigger to the webhook binding", async () => {
    let requestedPath = "";
    let method = "";
    let requestedBody: unknown;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requestedPath = String(input);
      method = init?.method ?? "";
      requestedBody =
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse(200, {
        id: "rt_1",
        name: "Granola calls",
        definitionId: "def_1",
        trigger: { kind: "webhook", webhookTriggerId: "wht_2" },
        scope: "bench",
        input: {},
        enabled: true,
        deliveryChannelId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
    }) as unknown as typeof fetch;

    await bindRoutineWebhookTrigger("ten_1", "rt_1", "wht_2");
    expect(requestedPath).toBe("/api/tenants/ten_1/routines/rt_1");
    expect(method).toBe("PATCH");
    expect(requestedBody).toEqual({
      trigger: { kind: "webhook", webhookTriggerId: "wht_2" },
    });
  });
});

describe("webhookTriggerUrl", () => {
  test("builds the ingress URL from the trigger id", () => {
    expect(webhookTriggerUrl("wht_1")).toContain("/api/webhooks/wht_1");
  });
});

describe("sampleGranolaWebhookPayload", () => {
  test("returns a pretty-printed illustrative JSON payload", () => {
    const parsed: unknown = JSON.parse(sampleGranolaWebhookPayload());
    expect(typeof parsed).toBe("object");
  });
});
