import { afterEach, describe, expect, it } from "bun:test";
import {
  listData,
  mergeCookies,
  resolveCredentialBinding,
  seedCatalog,
  type CredentialRow,
} from "./seed-catalog";

describe("mergeCookies", () => {
  it("appends a new cookie", () => {
    expect(mergeCookies([], ["a=1; Path=/; HttpOnly"])).toEqual(["a=1"]);
  });

  it("replaces an existing cookie by name", () => {
    expect(mergeCookies(["a=1"], ["a=2; Path=/"])).toEqual(["a=2"]);
  });

  it("keeps unrelated cookies and appends the new one", () => {
    expect(mergeCookies(["a=1"], ["b=2; Secure"])).toEqual(["a=1", "b=2"]);
  });

  it("ignores malformed set-cookie headers", () => {
    expect(mergeCookies(["a=1"], [""])).toEqual(["a=1"]);
  });
});

describe("listData", () => {
  it("returns the data array", () => {
    expect(listData<number>({ data: [1, 2] })).toEqual([1, 2]);
  });

  it("returns [] when data is missing", () => {
    expect(listData({})).toEqual([]);
    expect(listData(null)).toEqual([]);
  });
});

describe("resolveCredentialBinding", () => {
  const credentials: CredentialRow[] = [
    {
      id: "cred_1",
      name: "opencode-zen",
      metadata: { baseURL: "https://zen.example/v1" },
    },
    { id: "cred_2", name: "no-base", metadata: { model: "x" } },
  ];

  it("returns id + baseURL for a credential with metadata.baseURL", () => {
    expect(resolveCredentialBinding(credentials, "opencode-zen")).toEqual({
      id: "cred_1",
      baseURL: "https://zen.example/v1",
    });
  });

  it("throws when the credential is absent", () => {
    expect(() => resolveCredentialBinding(credentials, "missing")).toThrow(
      /not found — run seed-credentials/,
    );
  });

  it("throws when the credential has no metadata.baseURL", () => {
    expect(() => resolveCredentialBinding(credentials, "no-base")).toThrow(
      /no metadata.baseURL/,
    );
  });
});

describe("seedCatalog offering priority", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends each offering's catalog priority so Bifrost outranks opencode-zen", async () => {
    const createdOfferings: {
      providerId: string;
      modelId: string;
      priority: number;
    }[] = [];

    // Only these two providers carry a credential, so seedCatalog seeds just
    // them and creates offerings for both — exactly the pair whose relative
    // priority decides the head source.
    const credentials = [
      {
        id: "cred_bifrost",
        name: "Corbits Default Bifrost",
        metadata: { baseURL: "http://bifrost.example:8080/v1" },
      },
      {
        id: "cred_zen",
        name: "opencode-zen",
        metadata: { baseURL: "https://zen.example/v1" },
      },
    ];

    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (method === "GET" && url.endsWith("/credentials")) {
        return json({ data: credentials }, 200);
      }
      if (url.endsWith("/catalog/providers")) {
        if (method === "GET") return json({ data: [] }, 200);
        return json({ id: `prov:${body.name}` }, 201);
      }
      if (url.endsWith("/catalog/models")) {
        if (method === "GET") return json({ data: [] }, 200);
        return json({ id: `model:${body.canonicalName}` }, 201);
      }
      if (url.endsWith("/catalog/offerings")) {
        if (method === "GET") return json({ data: [] }, 200);
        createdOfferings.push({
          providerId: body.providerId,
          modelId: body.modelId,
          priority: body.priority,
        });
        return json({ id: `off:${createdOfferings.length}` }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await seedCatalog("tenant_test", ["session=1"]);

    const byProvider = (name: string) =>
      createdOfferings.filter((o) => o.providerId === `prov:${name}`);
    const bifrost = byProvider("corbits-default-bifrost");
    const zen = byProvider("opencode-zen");

    expect(bifrost.length).toBeGreaterThan(0);
    expect(zen.length).toBeGreaterThan(0);
    // Priority is threaded from the spec, not the old hardcoded 0.
    expect(createdOfferings.some((o) => o.priority !== 0)).toBe(true);

    // For every model both providers offer, Bifrost's priority is lower (head).
    const zenByModel = new Map(zen.map((o) => [o.modelId, o.priority]));
    let comparedPairs = 0;
    for (const b of bifrost) {
      const z = zenByModel.get(b.modelId);
      if (z === undefined) continue;
      comparedPairs += 1;
      expect(b.priority).toBeLessThan(z);
    }
    expect(comparedPairs).toBeGreaterThan(0);
  });

  it("reprioritizes an existing offering in place when its stored priority differs", async () => {
    const patched: { id: string; priority: number }[] = [];
    let postedOfferings = 0;

    const credentials = [
      {
        id: "cred_bifrost",
        name: "Corbits Default Bifrost",
        metadata: { baseURL: "http://bifrost.example:8080/v1" },
      },
      {
        id: "cred_zen",
        name: "opencode-zen",
        metadata: { baseURL: "https://zen.example/v1" },
      },
    ];

    // A pre-existing bifrost offering for kimi-k2.6 stored at a stale non-spec
    // priority (99); the spec wants the /v1 Bifrost head at priority 1.
    const existingOfferings = [
      {
        id: "off_existing_bifrost_kimi",
        modelId: "model:kimi-k2.6",
        providerId: "prov:corbits-default-bifrost",
        priority: 99,
      },
    ];

    const json = (body: unknown, status: number): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};

      if (method === "GET" && url.endsWith("/credentials")) {
        return json({ data: credentials }, 200);
      }
      if (url.endsWith("/catalog/providers")) {
        if (method === "GET") return json({ data: [] }, 200);
        return json({ id: `prov:${body.name}` }, 201);
      }
      if (url.endsWith("/catalog/models")) {
        if (method === "GET") return json({ data: [] }, 200);
        return json({ id: `model:${body.canonicalName}` }, 201);
      }
      if (method === "PATCH" && url.includes("/catalog/offerings/")) {
        patched.push({
          id: url.split("/").pop() as string,
          priority: body.priority,
        });
        return json({ id: url.split("/").pop() }, 200);
      }
      if (url.endsWith("/catalog/offerings")) {
        if (method === "GET") return json({ data: existingOfferings }, 200);
        postedOfferings += 1;
        return json({ id: `off:new:${postedOfferings}` }, 201);
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }) as typeof fetch;

    await seedCatalog("tenant_test", ["session=1"]);

    // The stale offering is PATCHed to its spec priority (1 for bifrost /v1),
    // not left at 99 and not re-created.
    expect(patched).toContainEqual({
      id: "off_existing_bifrost_kimi",
      priority: 1,
    });
    // A brand-new offering (e.g. opencode-zen for kimi) is still POSTed.
    expect(postedOfferings).toBeGreaterThan(0);
  });
});
