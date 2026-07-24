import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";
import { providerWebhookDelivery } from "../db/schema";
import {
  createProviderWebhookRegistry,
  type ProviderWebhookAdapter,
} from "../lib/provider-webhooks";
import { linearWebhookAdapter } from "../lib/provider-webhook-adapters/linear";
import {
  createProviderWebhookRouter,
  type ProviderWebhookEvent,
} from "./webhooks-provider-triggers";

const SECRET = "whsec_linear_test";
const TENANT_ID = "root-tenant";
const ORG_ID = "org-abc123";

type FakeDbOptions = {
  providerMetadata: unknown;
  credentialSecret: string | null;
  existingDeliveryIds?: string[];
};

function makeDb(opts: FakeDbOptions): {
  db: HubDb;
  insertedIds: string[];
} {
  const deliveryIds = new Set(opts.existingDeliveryIds ?? []);
  const insertedIds: string[] = [];

  const db = {
    query: {
      provider: {
        findFirst: async () =>
          opts.providerMetadata === undefined
            ? null
            : { id: "prov-1", metadata: opts.providerMetadata },
      },
      credential: {
        findFirst: async () =>
          opts.credentialSecret === null
            ? null
            : { secret: opts.credentialSecret },
      },
    },
    insert: (table: unknown) => {
      if (table !== providerWebhookDelivery) {
        throw new Error("unexpected insert target in fake db");
      }
      return {
        values: (row: { id: string }) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              if (deliveryIds.has(row.id)) return [];
              deliveryIds.add(row.id);
              insertedIds.push(row.id);
              return [{ id: row.id }];
            },
          }),
        }),
      };
    },
  };

  return { db: db as unknown as HubDb, insertedIds };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    organizationId: ORG_ID,
    webhookId: "wh-1",
    webhookTimestamp: Date.now(),
    data: { id: "issue-1" },
    ...overrides,
  });
}

function req(
  path: string,
  body: string,
  opts: {
    signature?: string;
    signatureHeader?: string;
    deliveryId?: string;
    deliveryHeader?: string;
  } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (opts.signature !== undefined) {
    headers.set(opts.signatureHeader ?? "linear-signature", opts.signature);
  }
  headers.set(
    opts.deliveryHeader ?? "linear-delivery",
    opts.deliveryId ?? "delivery-1",
  );
  return new Request(`http://local${path}`, {
    method: "POST",
    headers,
    body,
  });
}

function makeApp(
  db: HubDb,
  registryAdapters: ProviderWebhookAdapter[],
  onEvent?: (event: ProviderWebhookEvent) => Promise<void>,
): Hono {
  const app = new Hono();
  app.route(
    "/",
    createProviderWebhookRouter({
      db,
      rootTenantId: TENANT_ID,
      registry: createProviderWebhookRegistry(registryAdapters),
      ...(onEvent ? { onEvent } : {}),
    }),
  );
  return app;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition never became true");
}

describe("POST /webhooks/triggers/:provider (Linear adapter)", () => {
  it("verifies a valid signature over the raw body and reaches the handler", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const events: ProviderWebhookEvent[] = [];
    const app = makeApp(db, [linearWebhookAdapter], async (e) => {
      events.push(e);
    });

    const body = envelope();
    const res = await app.fetch(
      req("/webhooks/triggers/linear", body, { signature: sign(body, SECRET) }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await waitUntil(() => events.length > 0);
    expect(events).toEqual([
      {
        provider: "linear",
        tenantId: TENANT_ID,
        tenantKey: ORG_ID,
        deliveryId: "delivery-1",
        webhookId: "wh-1",
        action: "update",
        entityType: "Issue",
        data: { id: "issue-1" },
      },
    ]);
  });

  it("rejects a tampered body: a signature computed over a different body does not verify", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const events: ProviderWebhookEvent[] = [];
    const app = makeApp(db, [linearWebhookAdapter], async (e) => {
      events.push(e);
    });

    const signedBody = envelope({ action: "create" });
    const tamperedBody = envelope({ action: "remove" });
    const res = await app.fetch(
      req("/webhooks/triggers/linear", tamperedBody, {
        signature: sign(signedBody, SECRET),
      }),
    );

    expect(res.status).toBe(401);
    expect(events.length).toBe(0);
  });

  it("rejects a missing signature header", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const app = makeApp(db, [linearWebhookAdapter]);

    const res = await app.fetch(req("/webhooks/triggers/linear", envelope()));
    expect(res.status).toBe(401);
  });

  it("rejects a delivery whose webhookTimestamp is outside the replay window", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const events: ProviderWebhookEvent[] = [];
    const app = makeApp(db, [linearWebhookAdapter], async (e) => {
      events.push(e);
    });

    const staleBody = envelope({ webhookTimestamp: Date.now() - 5 * 60_000 });
    const res = await app.fetch(
      req("/webhooks/triggers/linear", staleBody, {
        signature: sign(staleBody, SECRET),
      }),
    );

    expect(res.status).toBe(401);
    expect(events.length).toBe(0);
  });

  it("collapses a redelivered Linear-Delivery id to a single dispatch", async () => {
    const { db, insertedIds } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const events: ProviderWebhookEvent[] = [];
    const app = makeApp(db, [linearWebhookAdapter], async (e) => {
      events.push(e);
    });

    const body = envelope();
    const opts = { signature: sign(body, SECRET), deliveryId: "dup-1" };

    const first = await app.fetch(req("/webhooks/triggers/linear", body, opts));
    expect(first.status).toBe(200);
    await waitUntil(() => events.length > 0);

    const second = await app.fetch(
      req("/webhooks/triggers/linear", body, opts),
    );
    expect(second.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.length).toBe(1);
    expect(insertedIds).toEqual(["linear:dup-1"]);
  });

  it("rejects an organizationId that does not match the configured tenant, explicitly, without guessing", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const events: ProviderWebhookEvent[] = [];
    const app = makeApp(db, [linearWebhookAdapter], async (e) => {
      events.push(e);
    });

    const body = envelope({ organizationId: "org-someone-else" });
    const res = await app.fetch(
      req("/webhooks/triggers/linear", body, { signature: sign(body, SECRET) }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unknown tenant" });
    expect(events.length).toBe(0);
  });

  it("503s when no webhook credential is configured for the provider", async () => {
    const { db } = makeDb({
      providerMetadata: undefined,
      credentialSecret: null,
    });
    const app = makeApp(db, [linearWebhookAdapter]);

    const body = envelope();
    const res = await app.fetch(
      req("/webhooks/triggers/linear", body, { signature: sign(body, SECRET) }),
    );
    expect(res.status).toBe(503);
  });

  it("413s a body over the size ceiling", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const app = makeApp(db, [linearWebhookAdapter]);

    const oversized = JSON.stringify({ blob: "x".repeat(300_000) });
    const res = await app.fetch(
      req("/webhooks/triggers/linear", oversized, {
        signature: sign(oversized, SECRET),
      }),
    );
    expect(res.status).toBe(413);
  });

  it("404s an unregistered provider", async () => {
    const { db } = makeDb({
      providerMetadata: { organizationId: ORG_ID },
      credentialSecret: SECRET,
    });
    const app = makeApp(db, [linearWebhookAdapter]);

    const res = await app.fetch(
      req("/webhooks/triggers/github", envelope(), {
        signature: "a".repeat(64),
      }),
    );
    expect(res.status).toBe(404);
  });
});

// A minimal second adapter with a DIFFERENT signature scheme (sha256 of
// `secret + body`, hex-encoded, no HMAC), different header names, and a
// different tenant-key field -- registered without touching the route above.
// Proves the receiver is generic, not "Linear plus a path param".
const FAKE_SECRET = "fake-provider-secret";
const FAKE_WORKSPACE_ID = "ws-fake-1";

const fakeAdapter: ProviderWebhookAdapter = {
  provider: "fake",
  signatureHeader: "x-fake-signature",
  deliveryIdHeader: "x-fake-delivery",
  replayToleranceMs: 60_000,
  tenantKeyMetadataField: "fakeWorkspaceId",
  parsePayload(rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as Record<string, unknown>;
      if (
        typeof parsed["workspaceId"] !== "string" ||
        typeof parsed["ts"] !== "number"
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  },
  verifySignature({ rawBody, signatureHeaderValue, secret }) {
    const expected = createHash("sha256")
      .update(secret + rawBody)
      .digest("hex");
    return expected === signatureHeaderValue;
  },
  extractTenantKey(payload) {
    return (payload as { workspaceId: string }).workspaceId;
  },
  extractTimestampMs(payload) {
    return (payload as { ts: number }).ts;
  },
  extractDeliveryMeta(payload) {
    const p = payload as { event?: string; id?: string };
    if (!p.event || !p.id) return null;
    return {
      action: p.event,
      entityType: "fake-entity",
      webhookId: p.id,
      data: payload,
    };
  },
};

function fakeSign(body: string): string {
  return createHash("sha256")
    .update(FAKE_SECRET + body)
    .digest("hex");
}

describe("POST /webhooks/triggers/:provider (a second, differently-shaped adapter)", () => {
  it("registers and verifies alongside Linear without any route change", async () => {
    const { db } = makeDb({
      providerMetadata: { fakeWorkspaceId: FAKE_WORKSPACE_ID },
      credentialSecret: FAKE_SECRET,
    });
    const events: ProviderWebhookEvent[] = [];
    const app = makeApp(db, [linearWebhookAdapter, fakeAdapter], async (e) => {
      events.push(e);
    });

    const body = JSON.stringify({
      workspaceId: FAKE_WORKSPACE_ID,
      ts: Date.now(),
      event: "poked",
      id: "fake-delivery-1",
    });
    const res = await app.fetch(
      req("/webhooks/triggers/fake", body, {
        signature: fakeSign(body),
        signatureHeader: "x-fake-signature",
        deliveryId: "fd-1",
        deliveryHeader: "x-fake-delivery",
      }),
    );

    expect(res.status).toBe(200);
    await waitUntil(() => events.length > 0);
    expect(events[0]?.provider).toBe("fake");
    expect(events[0]?.tenantKey).toBe(FAKE_WORKSPACE_ID);
    expect(events[0]?.action).toBe("poked");
  });

  it("rejects the fake provider's bad signature the same way Linear's is rejected", async () => {
    const { db } = makeDb({
      providerMetadata: { fakeWorkspaceId: FAKE_WORKSPACE_ID },
      credentialSecret: FAKE_SECRET,
    });
    const app = makeApp(db, [linearWebhookAdapter, fakeAdapter]);

    const body = JSON.stringify({
      workspaceId: FAKE_WORKSPACE_ID,
      ts: Date.now(),
      event: "poked",
      id: "fake-delivery-2",
    });
    const res = await app.fetch(
      req("/webhooks/triggers/fake", body, {
        signature: "0".repeat(64),
        signatureHeader: "x-fake-signature",
        deliveryHeader: "x-fake-delivery",
      }),
    );
    expect(res.status).toBe(401);
  });
});
