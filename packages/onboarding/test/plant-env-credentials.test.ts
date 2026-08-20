import { describe, expect, test } from "bun:test";
import type { ApiCall, SeedCatalogArgs } from "@workbench/hub-client";
import {
  envProviderBaseUrlsFrom,
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
function credentialsApi(
  activeNames: Set<string>,
  revokedNames: Set<string> = new Set<string>(),
): ApiCall {
  return async (method, path) => {
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/credentials`)
    ) {
      const active = [...activeNames].map((name) => ({
        id: `cred_${name}`,
        tenantId: TENANT_ID,
        providerId: `prov_${name}`,
        name,
        type: "api_key",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }));
      const revoked = [...revokedNames].map((name) => ({
        id: `cred_revoked_${name}`,
        tenantId: TENANT_ID,
        providerId: `prov_${name}`,
        name,
        type: "api_key",
        status: "revoked",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }));
      return {
        status: 200,
        data: { data: [...active, ...revoked], nextCursor: null },
        cookies: [],
      };
    }
    throw new Error(`unexpected call: ${method} ${path}`);
  };
}

/** A paginated credentials-list ApiCall for the follow-nextCursor test:
 * the target row lives on page two, so a caller that only reads page
 * one would never see it. */
function paginatedCredentialsApi(pages: string[][]): ApiCall {
  return async (method, path) => {
    if (!(
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/credentials`)
    )) {
      throw new Error(`unexpected call: ${method} ${path}`);
    }
    const url = new URL(path, "http://hub.test");
    const cursor = url.searchParams.get("cursor");
    const pageIndex = cursor === null ? 0 : Number(cursor);
    const names = pages[pageIndex] ?? [];
    const nextCursor =
      pageIndex + 1 < pages.length ? String(pageIndex + 1) : null;
    return {
      status: 200,
      data: {
        data: names.map((name) => ({
          id: `cred_${name}`,
          tenantId: TENANT_ID,
          providerId: `prov_${name}`,
          name,
          type: "api_key",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })),
        nextCursor,
      },
      cookies: [],
    };
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

  test("OLLAMA_BASE_URL's presence plants the fixed placeholder secret, never the URL", () => {
    const keys = envProviderKeysFrom({
      OLLAMA_BASE_URL: "http://localhost:11434",
    });
    expect(keys.ollama).toBe("ollama");
  });

  test("an empty OLLAMA_BASE_URL is treated as unset", () => {
    expect(envProviderKeysFrom({ OLLAMA_BASE_URL: "" })).toEqual({});
  });
});

describe("envProviderBaseUrlsFrom", () => {
  test("reads OLLAMA_BASE_URL as ollama's base URL", () => {
    expect(
      envProviderBaseUrlsFrom({
        OLLAMA_BASE_URL: "https://home-mac.example.ts.net",
      }),
    ).toEqual({ ollama: "https://home-mac.example.ts.net" });
  });

  test("an empty environment yields an empty map", () => {
    expect(envProviderBaseUrlsFrom({})).toEqual({});
  });

  test("an empty-string value is treated as unset", () => {
    expect(envProviderBaseUrlsFrom({ OLLAMA_BASE_URL: "" })).toEqual({});
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
    const active = new Set<string>();
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(active),
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
        // Mirrors the real `seedCatalog`'s side effect: a fresh plant
        // actually stores an active credential under this name.
        active.add("anthropic-default");
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
    // The rotated env key was never planted, and the message says where
    // to fix that.
    expect(lines[0]).toContain("was not planted");
    expect(lines[0]).toContain("rotate");
    expect(lines[0]).toContain("Plugins");
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

  test("plants ollama with its configured base URL threaded to both the probe and the seed", async () => {
    const { log } = collector();
    const active = new Set<string>();
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(active),
      cookies: ["session=abc"],
      tenantId: TENANT_ID,
      envProviderKeys: { ollama: "ollama" },
      envProviderBaseUrls: { ollama: "https://home-mac.example.ts.net" },
      log,
      testCredential: async (args) => {
        expect(args.provider).toBe("ollama");
        expect(args.baseURL).toBe("https://home-mac.example.ts.net");
        return { ok: true };
      },
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        active.add("ollama-default");
      },
    });

    expect(outcomes).toEqual([{ provider: "ollama", status: "planted" }]);
    expect(seedCatalogCalls[0]?.baseURLOverride).toBe(
      "https://home-mac.example.ts.net",
    );
  });

  test("one provider's failed probe never blocks another provider's plant", async () => {
    const { log } = collector();
    const active = new Set<string>();
    const planted: string[] = [];
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(active),
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
        active.add("openai-default");
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

  test("a revoked existing credential of the same name blocks the plant instead of being reported as planted", async () => {
    const { log, lines } = collector();
    // No active row (so the pre-check probes), but a revoked row with
    // the same name already exists — `seedCatalog`'s `ensureCredential`
    // 409-skips an `api_key` row it does not own the rotation of, so the
    // proven env key is never actually stored.
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set(), new Set(["anthropic-default"])),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async () => ({ ok: true as const }),
      seedCatalogFn: async () => {
        // Mirrors the real `ensureCredential`'s 409-skip: the revoked
        // row is left untouched, so the credentials list still shows no
        // active row for this provider.
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "blocked" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("anthropic-default");
    expect(lines[0]).toContain("not active");
    expect(lines[0]).toContain("not stored");
    expect(lines[0]).not.toContain("planted (catalog ready)");
    expect(lines[0]).not.toContain("sk-ant-real");
  });

  test("a probe-failure message with a token-shaped substring is redacted before logging", async () => {
    const { log, lines } = collector();
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set()),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { openai: "sk-oai-real-secret-value" },
      log,
      testCredential: async () => ({
        ok: false,
        message:
          "OpenAI rejected key sk-oai-real-secret-value-echoed-back: invalid_api_key",
      }),
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("failed");
    expect(outcomes[0]?.message).not.toContain("sk-oai-real-secret-value");
    expect(outcomes[0]?.message).toContain("[redacted]");
    expect(lines[0]).not.toContain("sk-oai-real-secret-value");
    expect(lines[0]).toContain("[redacted]");
  });

  test("findActiveCredential follows nextCursor instead of reading only page one", async () => {
    const { log } = collector();
    let probed = false;
    const outcomes = await plantEnvProviderCredentials({
      // The active "anthropic-default" row lives on page two only.
      api: paginatedCredentialsApi([
        ["other-provider-default"],
        ["anthropic-default"],
      ]),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async () => {
        probed = true;
        return { ok: true as const };
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probed).toBe(false);
  });
});
