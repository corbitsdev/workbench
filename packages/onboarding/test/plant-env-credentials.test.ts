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

/** The curated provider key a fake credential row's name belongs to —
 * every fixture in this suite either uses the env-plant's own
 * `<provider>-default` naming convention or (for the
 * Settings-connected-credential tests) supplies its own explicit
 * `providerKey`, so a bare fixture name is always `<provider>-default`. */
function providerKeyOf(name: string): string {
  return name.replace(/-default$/, "");
}

type CredentialFixture = {
  readonly name: string;
  readonly providerKey?: string;
  /** Defaults to "api_key" — the type every fixture in this suite has
   * used until the non-inference-type test, which sets this to a type
   * `findActiveCredential` must not recognize as the plant. */
  readonly type?: "api_key" | "oauth_token" | "certificate" | "other";
};

function fixture(name: string): CredentialFixture {
  return { name };
}

function providerRow(providerKey: string) {
  return {
    id: `prov_${providerKey}`,
    tenantId: TENANT_ID,
    name: providerKey,
    plugin: "http",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function credentialRow(
  fixture: CredentialFixture,
  status: "active" | "revoked",
  idPrefix: string,
) {
  const providerKey = fixture.providerKey ?? providerKeyOf(fixture.name);
  return {
    id: `${idPrefix}${fixture.name}`,
    tenantId: TENANT_ID,
    providerId: `prov_${providerKey}`,
    name: fixture.name,
    type: fixture.type ?? "api_key",
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A minimal credentials-and-providers-list ApiCall: answers
 * `GET /api/tenants/:id/credentials` with whatever `active`/`revoked`
 * fixtures hold, `GET /api/tenants/:id/providers` with the provider row
 * each fixture's `providerKey` belongs to, and 404s everything else —
 * `plantEnvProviderCredentials` never calls anything else through `api`
 * itself (the plant/probe indirections are always passed as fakes in
 * these tests). */
function credentialsApi(
  active:
    ReadonlySet<string | CredentialFixture> | readonly CredentialFixture[],
  revoked:
    ReadonlySet<string | CredentialFixture> | readonly CredentialFixture[] = [],
): ApiCall {
  // Read `active`/`revoked` fresh on every call rather than snapshotting
  // once: several tests mutate the `Set` they passed in (mirroring a
  // real `seedCatalog`'s side effect) after the fake is built, and rely
  // on the next call seeing that mutation.
  function currentFixtures(
    entries:
      ReadonlySet<string | CredentialFixture> | readonly CredentialFixture[],
  ): CredentialFixture[] {
    return [...entries].map((entry) =>
      typeof entry === "string" ? fixture(entry) : entry,
    );
  }
  return async (method, path) => {
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/credentials`)
    ) {
      const rows = [
        ...currentFixtures(active).map((f) =>
          credentialRow(f, "active", "cred_"),
        ),
        ...currentFixtures(revoked).map((f) =>
          credentialRow(f, "revoked", "cred_revoked_"),
        ),
      ];
      return {
        status: 200,
        data: { data: rows, nextCursor: null },
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/providers`)
    ) {
      const providerKeys = new Set(
        [...currentFixtures(active), ...currentFixtures(revoked)].map(
          (f) => f.providerKey ?? providerKeyOf(f.name),
        ),
      );
      return {
        status: 200,
        data: {
          data: [...providerKeys].map((key) => providerRow(key)),
          nextCursor: null,
        },
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
  const providerKeys = new Set(pages.flat().map(providerKeyOf));
  return async (method, path) => {
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/providers`)
    ) {
      return {
        status: 200,
        data: {
          data: [...providerKeys].map((key) => providerRow(key)),
          nextCursor: null,
        },
        cookies: [],
      };
    }
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
        data: names.map((name) =>
          credentialRow(fixture(name), "active", "cred_"),
        ),
        nextCursor,
      },
      cookies: [],
    };
  };
}

/** A paginated providers-list ApiCall for the findProviderId
 * follow-nextCursor test: the target provider row lives on page two,
 * paired with a single active credential already sitting on that
 * provider so the test can assert the plant is recognized. */
function paginatedProvidersApi(
  pages: string[][],
  activeCredentialName: string,
): ApiCall {
  return async (method, path) => {
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/providers`)
    ) {
      const url = new URL(path, "http://hub.test");
      const cursor = url.searchParams.get("cursor");
      const pageIndex = cursor === null ? 0 : Number(cursor);
      const names = pages[pageIndex] ?? [];
      const nextCursor =
        pageIndex + 1 < pages.length ? String(pageIndex + 1) : null;
      return {
        status: 200,
        data: {
          data: names.map((key) => providerRow(key)),
          nextCursor,
        },
        cookies: [],
      };
    }
    if (
      method === "GET" &&
      path.startsWith(`/api/tenants/${TENANT_ID}/credentials`)
    ) {
      return {
        status: 200,
        data: {
          data: [
            credentialRow(fixture(activeCredentialName), "active", "cred_"),
          ],
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
        return { hasCompletionCapableModel: true };
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

  test("an already-active credential skips probe and key rotation, but backfills the curated catalog", async () => {
    const { log, lines } = collector();
    let probed = false;
    const seedCatalogCalls: SeedCatalogArgs[] = [];
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
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probed).toBe(false);
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedCatalogCalls[0]?.existingCredentialId).toBe(
      "cred_anthropic-default",
    );
    expect(seedCatalogCalls[0]?.apiKey).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skipped");
    expect(lines[0]).toContain("was not planted");
    expect(lines[0]).toContain("backfilled");
    expect(lines[0]).toContain("rotate");
    expect(lines[0]).toContain("Plugins");
    expect(lines[0]).not.toContain("sk-ant-rotated");
  });

  test("a Settings-connected credential under the same provider is recognized, so booting with the env key skips the probe and never creates a second credential row", async () => {
    const { log, lines } = collector();
    let probed = false;
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    const outcomes = await plantEnvProviderCredentials({
      // Named "Anthropic" (the connector's displayName, the way
      // `persistConnectorCredential` names a Settings-connected
      // credential) rather than this module's own "anthropic-default" —
      // both belong to the same `prov_anthropic` provider row.
      api: credentialsApi([{ name: "Anthropic", providerKey: "anthropic" }]),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-from-env" },
      log,
      testCredential: async () => {
        probed = true;
        return { ok: true };
      },
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probed).toBe(false);
    expect(seedCatalogCalls).toHaveLength(1);
    expect(seedCatalogCalls[0]?.existingCredentialId).toBe("cred_Anthropic");
    expect(seedCatalogCalls[0]?.apiKey).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Anthropic");
    expect(lines[0]).not.toContain("sk-ant-from-env");
  });

  test("a catalog backfill failure on an already-active credential is reported, never thrown", async () => {
    const { log, lines } = collector();
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set(["anthropic-default"])),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async () => {
        throw new Error("must not probe an already-active credential");
      },
      seedCatalogFn: async () => {
        throw new Error("catalog POST failed");
      },
    });

    expect(outcomes).toEqual([
      {
        provider: "anthropic",
        status: "failed",
        message: "catalog POST failed",
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("failed to backfill catalog");
    expect(lines[0]).toContain("catalog POST failed");
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
        return { hasCompletionCapableModel: true };
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
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([{ provider: "ollama", status: "planted" }]);
    expect(seedCatalogCalls[0]?.baseURLOverride).toBe(
      "https://home-mac.example.ts.net",
    );
  });

  test("an already-active ollama credential still threads its base URL into the catalog backfill", async () => {
    const { log } = collector();
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(new Set(["ollama-default"])),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { ollama: "ollama" },
      envProviderBaseUrls: { ollama: "https://home-mac.example.ts.net" },
      log,
      testCredential: async () => {
        throw new Error("must not probe an already-active credential");
      },
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([{ provider: "ollama", status: "skipped" }]);
    expect(seedCatalogCalls[0]?.existingCredentialId).toBe(
      "cred_ollama-default",
    );
    expect(seedCatalogCalls[0]?.apiKey).toBeUndefined();
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
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([
      { provider: "anthropic", status: "failed", message: "rejected" },
      { provider: "openai", status: "planted" },
    ]);
    expect(planted).toEqual(["openai"]);
  });

  test("calling twice plants the credential once and backfills the catalog on every boot", async () => {
    const { log } = collector();
    const active = new Set<string>();
    const api = credentialsApi(active);
    let probeCount = 0;
    const seedCalls: SeedCatalogArgs[] = [];
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
      seedCatalogFn: async (seedArgs: SeedCatalogArgs) => {
        seedCalls.push(seedArgs);
        // A real `seedCatalog` call is what makes the credential active;
        // the fake mirrors that side effect so the second call's
        // pre-check sees it.
        active.add("anthropic-default");
        return { hasCompletionCapableModel: true };
      },
    };

    const first = await plantEnvProviderCredentials(args);
    const second = await plantEnvProviderCredentials(args);

    expect(first).toEqual([{ provider: "anthropic", status: "planted" }]);
    expect(second).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probeCount).toBe(1);
    expect(seedCalls).toHaveLength(2);
    expect(seedCalls[0]?.apiKey).toBe("sk-ant-real");
    expect(seedCalls[1]?.existingCredentialId).toBe("cred_anthropic-default");
    expect(seedCalls[1]?.apiKey).toBeUndefined();
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
        return { hasCompletionCapableModel: true };
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
    const seedCatalogCalls: SeedCatalogArgs[] = [];
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
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probed).toBe(false);
    expect(seedCatalogCalls[0]?.existingCredentialId).toBe(
      "cred_anthropic-default",
    );
  });

  test("findProviderId follows nextCursor instead of reading only page one", async () => {
    const { log } = collector();
    let probed = false;
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    const outcomes = await plantEnvProviderCredentials({
      // The "anthropic" provider row lives on page two only.
      api: paginatedProvidersApi(
        [["other-provider"], ["anthropic"]],
        "anthropic-default",
      ),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async () => {
        probed = true;
        return { ok: true as const };
      },
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        return { hasCompletionCapableModel: true };
      },
    });

    expect(outcomes).toEqual([{ provider: "anthropic", status: "skipped" }]);
    expect(probed).toBe(false);
    expect(seedCatalogCalls[0]?.existingCredentialId).toBe(
      "cred_anthropic-default",
    );
  });

  test("a non-inference credential type on the same provider is not recognized as the plant", async () => {
    const { log } = collector();
    let probed = false;
    const seedCatalogCalls: SeedCatalogArgs[] = [];
    // An active "certificate"-typed row already sits on the anthropic
    // provider — neither write path plants one of these today, but the
    // match must not be fooled by it into skipping the probe.
    const active = new Set<CredentialFixture>([
      {
        name: "anthropic-legacy-cert",
        providerKey: "anthropic",
        type: "certificate",
      },
    ]);
    const outcomes = await plantEnvProviderCredentials({
      api: credentialsApi(active),
      cookies: [],
      tenantId: TENANT_ID,
      envProviderKeys: { anthropic: "sk-ant-real" },
      log,
      testCredential: async () => {
        probed = true;
        return { ok: true as const };
      },
      seedCatalogFn: async (args) => {
        seedCatalogCalls.push(args);
        // Mirrors the real `seedCatalog`'s side effect: a fresh plant
        // actually stores an active `api_key` credential under this name.
        active.add({ name: "anthropic-default", providerKey: "anthropic" });
        return { hasCompletionCapableModel: true };
      },
    });

    expect(probed).toBe(true);
    expect(outcomes).toEqual([{ provider: "anthropic", status: "planted" }]);
    expect(seedCatalogCalls[0]?.apiKey).toBe("sk-ant-real");
  });
});
