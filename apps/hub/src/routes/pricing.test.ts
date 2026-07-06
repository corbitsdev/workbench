import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

let catalogImpl: () => Promise<unknown> = async () => ({
  source: "test",
  generatedAt: "2026-07-03T00:00:00.000Z",
  models: {
    "claude-opus-4-5": {
      modelId: "claude-opus-4-5",
      provider: "anthropic",
      providerName: "Anthropic",
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite: 6.25,
    },
  },
});
let logoImpl: (p: string) => Promise<string | null> = async () => "<svg></svg>";

mock.module("../lib/pricing", () => ({
  loadPriceCatalog: () => catalogImpl(),
  getProviderLogo: (p: string) => logoImpl(p),
}));

const { createPricingRouter } = await import("./pricing");

type Env = { Variables: { tenant: { id: string }; principal: { id: string } } };

function harness() {
  const hub = new Hono<Env>();
  hub.use("/api/tenants/:tenantId/pricing/*", async (c, next) => {
    c.set("tenant", { id: "tnt_test" });
    c.set("principal", { id: "pri_1" });
    await next();
  });
  hub.route("/api/tenants/:tenantId/pricing", createPricingRouter());
  return hub;
}

describe("GET /pricing", () => {
  it("returns the cached catalog", async () => {
    const res = await harness().request(
      "http://localhost/api/tenants/tnt_test/pricing",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: Record<string, { input: number }>;
    };
    expect(body.models["claude-opus-4-5"]?.input).toBe(5);
  });

  it("returns 503 when the catalog is unavailable", async () => {
    catalogImpl = async () => {
      throw new Error("models.dev down");
    };
    const res = await harness().request(
      "http://localhost/api/tenants/tnt_test/pricing",
    );
    expect(res.status).toBe(503);
    catalogImpl = async () => ({
      source: "test",
      generatedAt: "x",
      models: {},
    });
  });
});

describe("GET /pricing/logos/:provider", () => {
  it("serves svg markup with the right content type", async () => {
    const res = await harness().request(
      "http://localhost/api/tenants/tnt_test/pricing/logos/anthropic.svg",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(await res.text()).toContain("<svg");
  });

  it("404s when the provider has no logo", async () => {
    logoImpl = async () => null;
    const res = await harness().request(
      "http://localhost/api/tenants/tnt_test/pricing/logos/unknownprov",
    );
    expect(res.status).toBe(404);
    logoImpl = async () => "<svg></svg>";
  });

  it("rejects a malformed provider name", async () => {
    const res = await harness().request(
      "http://localhost/api/tenants/tnt_test/pricing/logos/..%2Fetc",
    );
    expect(res.status).toBe(400);
  });
});
