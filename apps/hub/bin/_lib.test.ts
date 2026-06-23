import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveTargetTenant } from "./_lib";

const realFetch = globalThis.fetch;
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

const principals = [
  {
    principalId: "p_global",
    tenantId: "tenant_global",
    tenantSlug: "abklabs",
    tenantName: "ABK Labs",
    kind: "user",
    status: "active",
    roles: [],
  },
  {
    principalId: "p_gtm",
    tenantId: "tenant_gtm",
    tenantSlug: "gtm",
    tenantName: "GTM Workbench",
    kind: "user",
    status: "active",
    roles: [],
  },
];

function stubPrincipals(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/me/principals")) {
      return new Response(
        JSON.stringify({ data: principals, nextCursor: null }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
}

beforeEach(() => {
  stubPrincipals();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (ttyDescriptor)
    Object.defineProperty(process.stdin, "isTTY", ttyDescriptor);
});

describe("resolveTargetTenant", () => {
  test("--tenant flag resolves the named sub-tenant", async () => {
    const target = await resolveTargetTenant({
      base: "https://hub.test",
      cookies: [],
      argv: ["--tenant", "gtm"],
      globalSlug: "abklabs",
    });
    expect(target).toEqual({
      tenantId: "tenant_gtm",
      slug: "gtm",
      name: "GTM Workbench",
    });
  });

  test("--tenant=<slug> form also resolves", async () => {
    const target = await resolveTargetTenant({
      base: "https://hub.test",
      cookies: [],
      argv: ["--tenant=gtm"],
      globalSlug: "abklabs",
    });
    expect(target.slug).toBe("gtm");
  });

  test("env var resolves the sub-tenant when no flag is present", async () => {
    process.env["WORKBENCH_SLUG"] = "gtm";
    try {
      const target = await resolveTargetTenant({
        base: "https://hub.test",
        cookies: [],
        argv: [],
        envVar: "WORKBENCH_SLUG",
        globalSlug: "abklabs",
      });
      expect(target.slug).toBe("gtm");
    } finally {
      delete process.env["WORKBENCH_SLUG"];
    }
  });

  test("non-TTY with no flag defaults to the global tenant", async () => {
    setTTY(false);
    const target = await resolveTargetTenant({
      base: "https://hub.test",
      cookies: [],
      argv: [],
      globalSlug: "abklabs",
    });
    expect(target.slug).toBe("abklabs");
    expect(target.tenantId).toBe("tenant_global");
  });

  test("unknown slug fails loud", async () => {
    expect(
      resolveTargetTenant({
        base: "https://hub.test",
        cookies: [],
        argv: ["--tenant", "nope"],
        globalSlug: "abklabs",
      }),
    ).rejects.toThrow(/not a principal of tenant "nope"/);
  });
});
