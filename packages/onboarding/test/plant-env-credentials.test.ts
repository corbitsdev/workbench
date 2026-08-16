import { describe, expect, test } from "bun:test";
import type { ApiCall, SeedCatalogArgs } from "@workbench/hub-client";
import {
  envProviderKeysFrom,
  plantEnvProviderCredentials,
} from "../src/plant-env-credentials";

const TENANT_ID = "ten_operator";

function collector() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

/** A minimal credentials-list ApiCall: answers
 * `GET /api/tenants/:id/credentials` with whatever `active` set holds,
 * and 404s everything else — `plantEnvProviderCredentials` never calls
 * anything else through `api` itself (the plant/probe indirections are
 * always passed as fakes in these tests). */
function credentialsApi(activeNames: Set<string>): ApiCall {
  return async (method, path) => {
    if (method === "GET" && path === `/api/tenants/${TENANT_ID}/credentials`) {
      return {
        status: 200,
        data: {
          data: [...activeNames].map((name) => ({
            id: `cred_${name}`,
            tenantId: TENANT_ID,
            providerId: `prov_${name}`,
            name,
            type: "api_key",
            status: "active",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          })),
          nextCursor: null,
        },
        cookies: [],
      };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  };
}

describe("envProviderKeysFrom", () => {
  test("reads every curated provider's conventional env var", () => {
    const keys = envProviderKeysFrom({
      ANTHROPIC_API_KEY: "sk-ant-1",
      OPENAI_API_KEY: "sk-oai-1",
      UNRELATED: "ignored",
    });
    expect(keys).toEqual({ anthropic: "sk-ant-1", openai: "sk-oai-1" });
  });

  test("prefers GEMINI_API_KEY over GOOGLE_API_KEY when both are set", () => {
    const keys = envProviderKeysFrom({
      GEMINI_API_KEY: "gemini-key",
      GOOGLE_API_KEY: "google-key",
    });
    expect(keys["google-genai"]).toBe("gemini-key");
  });

  test("falls back to GOOGLE_API_KEY when GEMINI_API_KEY is absent", () => {
    const keys = envProviderKeysFrom({ GOOGLE_API_KEY: "google-key" });
    expect(keys["google-genai"]).toBe("google-key");
  });

  test("an empty environment yields an empty map", () => {
    expect(envProviderKeysFrom({})).toEqual({});
  });

  test("an empty-string value is treated as unset", () => {
    expect(envProviderKeysFrom({ ANTHROPIC_API_KEY: "" })).toEqual({});
  });
});

describe("plantEnvProviderCredentials", () => {
  test("no keys present plants nothing and never calls the api", async () => {
    const { log, lines } = collector();
    const outcomes = await plantEnvProviderCredentials({
      api: async () => {
        throw new Error("api should not be called with no env keys");
      },
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: {},
      log,
    });
    expect(outcomes).toEqual([]);
    expect(lines).toEqual([]);
  });

  test("plants a fresh provider: probes then seeds the catalog", async () => {
    const { log, lines } = collector();
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set()),
      cookies: ["session=abc"],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async (args) => {
        expect(args.provider).toBe("anthropic");
        expect(args.apiKey).toBe("sk-ant-real");
        return { ok: true };
      },
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "planted" }]);
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedCatalogCalls[0]?.provider).toBe("anthropic");
    expect(seedCatalogCalls[0]?.apiKey).toBe("sk-ant-real");
    expect(seedCatalogCalls[0]?.tenantId).toBe(TENANT_ID);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("anthropic");
    expect(lines[0]).toContain("planted");
    expect(lines[0]).not.toContain("sk-ant-real");
  });

  test("skips a provider that already has an active credential, without probing or seeding", async () => {
    const { log, lines } = collector();
    let probed = false;
    let seeded = false;
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set(["anthropic-default"])),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-rotated" },
      log,
      testCredential: async () => {
        probed = true;
        return { ok: true };
      },
      seedCatalogFn: async () => {
        seeded = true;
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probed).toBe(false);
    expect(seeded).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skipped");
    expect(lines[0]).not.toContain("sk-ant-rotated");
  });

  test("a failed probe is reported, never persisted, and never thrown", async () => {
    const { log, lines } = collector();
    let seeded = false;
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set()),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-bad" },
      log,
      testCredential: async () => ({
        ok: false,
        message: "Anthropic rejected the request with status 401",
      }),
      seedCatalogFn: async () => {
        seeded = true;
      },
    });

    expect(outcomes).toEqual([
      {
        provider: "anthropic",
        status: "failed",
        message: "Anthropic rejected the request with status 401",
      },
    ]);
    expect(seeded).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("failed");
    expect(lines[0]).not.toContain("sk-ant-bad");
  });

  test("one provider's failed probe never blocks another provider's plant", async () => {
    const { log } = collector();
    const planted: string[] = [];
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set()),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-bad", openai: "sk-oai-good" },
      log,
      testCredential: async (args) => ({
        ok: args.provider === "openai",
        message: "rejected",
      }),
      seedCatalogFn: async (args) => {
        planted.push(args.provider ?? "unknown");
      },
    });

    expect(outcomes).toEqual([
      { provider: "anthropic", status: "failed", message: "rejected" },
      { provider: "openai", status: "planted" },
    ]);
    expect(planted).toEqual(["openai"]);
  });

  test("calling twice plants once — the second call finds the credential already active", async () => {
    const { log } = collector();
    const active = new Set<string>();
    const api = credentialsApi(active);
    let probeCount = 0;
    let seedCount = 0;
    const args = {
      api,
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async () => {
        probeCount += 1;
        return { ok: true as const };
      },
      seedCatalogFn: async () => {
        seedCount += 1;
        // A real `seedCatalog` call is what makes the credential active;
        // the fake mirrors that side effect so the second call's
        // pre-check sees it.
        active.add("anthropic-default");
      },
    };

    const first = await plantEnvProviderCredentials(args);
    const second = await plantEnvProviderCredentials(args);

    expect(first).toEqual([{ provider: "anthropic", status: "planted" }]);
    expect(second).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probeCount).toBe(1);
    expect(seedCount).toBe(1);
  });
});
