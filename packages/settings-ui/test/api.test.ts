// The settings-ui API client, tested the same way bench-ui/chat-ui test
// theirs: stub global fetch, call the exported function, assert both the
// request it made and how it parses the response.

import { afterEach, describe, expect, test } from "bun:test";

import { UnauthenticatedError } from "@corbits/api-query";
import {
  SettingsApiError,
  getAccount,
  getAuthConfig,
  renameBench,
} from "../src/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(respond: (path: string) => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path =
      typeof input === "string" ? input : new URL(String(input)).pathname;
    calls.push(init === undefined ? { path } : { path, init });
    return Promise.resolve(respond(path));
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("getAccount", () => {
  test("fetches /api/me and returns the parsed profile", async () => {
    const calls = stubFetch(() =>
      json({
        id: "user_1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        emailVerified: true,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const account = await getAccount();
    expect(calls[0]?.path).toBe("/api/me");
    expect(account.name).toBe("Ada Lovelace");
  });

  test("throws an UnauthenticatedError on 401", async () => {
    stubFetch(() => json(null, 401));
    await expect(getAccount()).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe("getAuthConfig", () => {
  test("fetches /api/auth-config and returns signup policy", async () => {
    const calls = stubFetch(() =>
      json({
        socialProviders: [],
        signupMode: "closed",
        allowedEmailDomains: ["example.com"],
      }),
    );
    const config = await getAuthConfig();
    expect(calls[0]?.path).toBe("/api/auth-config");
    expect(config.signupMode).toBe("closed");
    expect(config.allowedEmailDomains).toEqual(["example.com"]);
  });
});

describe("renameBench", () => {
  test("PATCHes the tenant with just the new name", async () => {
    const calls = stubFetch(() =>
      json({
        id: "tnt_1",
        name: "Launch team",
        slug: "acme",
        domain: "acme.localhost",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const bench = await renameBench("tnt_1", "Launch team");
    expect(calls[0]?.path).toBe("/api/tenants/tnt_1");
    expect(calls[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: "Launch team",
    });
    expect(bench.name).toBe("Launch team");
  });

  test("throws a SettingsApiError on a malformed response", async () => {
    stubFetch(() => json({ id: "tnt_1" }));
    await expect(renameBench("tnt_1", "New name")).rejects.toBeInstanceOf(
      SettingsApiError,
    );
  });
});
