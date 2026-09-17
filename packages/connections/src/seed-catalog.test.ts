// Tests for the credential + catalog planting now owned by this package
//: `seedCatalog` plants one provider's curated catalog
// idempotently and refuses a placeholder credential for OAuth-only
// providers. The hub HTTP API is an in-memory stub below — no network,
// no database.

import { describe, expect, test } from "bun:test";
import type { ApiCall } from "@corbits/hub-api-client";
import { CATALOG_SEEDS } from "./catalog-seed-data";
import {
  inferenceCredentialName,
  PLACEHOLDER_CATALOG_API_KEY,
  PlaceholderCredentialError,
  seedCatalog,
} from "./seed-catalog";

const NOW = "2026-09-15T00:00:00.000Z";

/** In-memory hub: create-by-name returns 201 once, 409 after; GET lists. */
function stubHub() {
  const calls: { method: string; path: string }[] = [];
  const providers: { id: string; name: string; plugin: string }[] = [];
  const credentials: { id: string; name: string }[] = [];
  const models: { id: string; canonicalName: string }[] = [];
  const catalogProviders: { id: string; name: string }[] = [];
  const offerings: { id: string; modelId: string; providerId: string }[] = [];

  const api = (async (method: string, path: string, body: Record<string, unknown> | undefined) => {
    calls.push({ method, path });
    const row = (id: string, extra: Record<string, unknown> = {}) => ({
      id,
      tenantId: "tnt_1",
      disabled: false,
      createdAt: NOW,
      updatedAt: NOW,
      ...extra,
    });
    // Catalog routes first: "/catalog/providers" also ends with
    // "/providers", so the tenant-provider branch below must not see it.
    if (method === "POST" && path.endsWith("/catalog/providers")) {
      const name = body?.["name"] as string;
      const found = catalogProviders.find((p) => p.name === name);
      if (found) return { status: 409, data: {} };
      const created = {
        id: `cprv_${name}`,
        name,
        plugin: body?.["plugin"] as string,
        baseURL: body?.["baseURL"],
        credentialId: body?.["credentialId"],
      };
      catalogProviders.push(created);
      return { status: 201, data: row(created.id, created) };
    }
    if (method === "GET" && path.endsWith("/catalog/providers")) {
      return {
        status: 200,
        data: {
          data: catalogProviders.map((p) => row(p.id, p)),
          nextCursor: null,
        },
      };
    }
    if (method === "POST" && path.endsWith("/catalog/offerings")) {
      const modelId = body?.["modelId"] as string;
      const providerId = body?.["providerId"] as string;
      const found = offerings.find((o) => o.modelId === modelId && o.providerId === providerId);
      if (found) return { status: 409, data: {} };
      const created = {
        id: `off_${modelId}_${providerId}`,
        modelId,
        providerId,
        priority: body?.["priority"],
        deploymentTags: [],
        capabilities: body?.["capabilities"] ?? [],
        quirks: body?.["quirks"] ?? null,
      };
      offerings.push(created);
      return { status: 201, data: row(created.id, created) };
    }
    if (method === "GET" && path.startsWith("/api/tenants/tnt_1/catalog/offerings")) {
      return {
        status: 200,
        data: { data: offerings.map((o) => row(o.id, o)), nextCursor: null },
      };
    }
    if (method === "POST" && path.endsWith("/providers")) {
      const name = body?.["name"] as string;
      const found = providers.find((p) => p.name === name);
      if (found) return { status: 409, data: {} };
      const created = {
        id: `prv_${name}`,
        name,
        plugin: body?.["plugin"] as string,
        apiBaseUrl: body?.["apiBaseUrl"] ?? null,
      };
      providers.push(created);
      return { status: 201, data: row(created.id, created) };
    }
    if (method === "GET" && path.endsWith("/providers?inherited=false")) {
      return {
        status: 200,
        data: {
          data: providers.map((p) => row(p.id, p)),
          nextCursor: null,
        },
      };
    }
    if (method === "POST" && path.endsWith("/credentials")) {
      const name = body?.["name"] as string;
      const found = credentials.find((c) => c.name === name);
      if (found) return { status: 409, data: {} };
      const created = {
        id: `cred_${name}`,
        providerId: body?.["providerId"],
        name,
        type: body?.["type"],
        status: "active",
      };
      credentials.push(created);
      return { status: 201, data: row(created.id, created) };
    }
    if (method === "GET" && path.endsWith("/credentials")) {
      return {
        status: 200,
        data: {
          data: credentials.map((c) => row(c.id, c)),
          nextCursor: null,
        },
      };
    }
    if (method === "POST" && path.endsWith("/catalog/models")) {
      const canonicalName = body?.["canonicalName"] as string;
      const found = models.find((m) => m.canonicalName === canonicalName);
      if (found) return { status: 409, data: {} };
      const created = { id: `mdl_${canonicalName}`, canonicalName };
      models.push(created);
      return { status: 201, data: row(created.id, created) };
    }
    if (method === "GET" && path.endsWith("/catalog/models")) {
      return {
        status: 200,
        data: { data: models.map((m) => row(m.id, m)), nextCursor: null },
      };
    }
    throw new Error(`unexpected hub call ${method} ${path}`);
  }) as ApiCall;
  return { api, calls, providers, credentials, models, offerings };
}

describe("seedCatalog", () => {
  test("plants the curated openai catalog with a placeholder credential", async () => {
    const { api, models, credentials, offerings } = stubHub();
    const lines: string[] = [];
    const result = await seedCatalog({
      api,
      cookies: [],
      tenantId: "tnt_1",
      log: (line) => lines.push(line),
      provider: "openai",
      placeholderCredential: true,
    });

    expect(models.map((m) => m.canonicalName)).toEqual(
      CATALOG_SEEDS.openai.models.map((m) => m.canonicalName),
    );
    expect(credentials.map((c) => c.name)).toEqual(["openai-default"]);
    expect(offerings).toHaveLength(CATALOG_SEEDS.openai.models.length);
    expect(lines.join("\n")).toContain("catalog ready: openai/gpt-5.6-terra, gpt-4o-mini");
    expect(result.hasCompletionCapableModel).toBe(true);
  });

  test("a re-run finds every row by name and plants nothing new", async () => {
    const stub = stubHub();
    const { api } = stub;
    const first: string[] = [];
    await seedCatalog({
      api,
      cookies: [],
      tenantId: "tnt_1",
      log: (line) => first.push(line),
      provider: "openai",
      placeholderCredential: true,
    });
    const rows = () =>
      stub.providers.length + stub.credentials.length + stub.models.length + stub.offerings.length;

    const before = rows();
    const second: string[] = [];
    const result = await seedCatalog({
      api,
      cookies: [],
      tenantId: "tnt_1",
      log: (line) => second.push(line),
      provider: "openai",
      placeholderCredential: true,
    });

    // Every create collided (409) and fell through to the list-and-reuse
    // path, so the row count is unchanged.
    expect(rows()).toBe(before);
    expect(second.join("\n")).toContain("already exists (skipped)");
    expect(result.hasCompletionCapableModel).toBe(true);
  });

  test("refuses a placeholder credential for the OAuth-only codex provider", async () => {
    const { api } = stubHub();
    await expect(
      seedCatalog({
        api,
        cookies: [],
        tenantId: "tnt_1",
        log: () => undefined,
        provider: "codex",
        placeholderCredential: true,
      }),
    ).rejects.toBeInstanceOf(PlaceholderCredentialError);
  });
});

describe("catalog seed data", () => {
  test("every curated provider names at least one model", () => {
    for (const [provider, seed] of Object.entries(CATALOG_SEEDS)) {
      expect(seed.models.length, provider).toBeGreaterThan(0);
      expect(seed.provider.name, provider).toBe(provider);
    }
  });

  test("inferenceCredentialName keeps the <provider>-default convention", () => {
    expect(inferenceCredentialName("anthropic")).toBe("anthropic-default");
    expect(PLACEHOLDER_CATALOG_API_KEY).toBe("placeholder-not-a-real-key");
  });
});
