import { describe, expect, it, mock } from "bun:test";
import type { MemberPreferences } from "@workbench/shared";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({}),
}));

let member: { tenantId: string; principalId: string } | null = {
  tenantId: "ten-1",
  principalId: "pri-1",
};
mock.module("../lib/tenant-provisioning", () => ({
  resolveCallerMember: mock(async () => member),
}));

const mergeMemberPreferences = mock(
  async (
    _db,
    _t,
    _p,
    patch: Record<string, unknown>,
  ): Promise<MemberPreferences> => ({
    theme: "notion",
    ...patch,
  }),
);
const readMemberPreferences = mock(
  async (): Promise<MemberPreferences> => ({ theme: "notion" }),
);
mock.module("../lib/member-preferences", () => ({
  mergeMemberPreferences,
  readMemberPreferences,
}));

let availableProviderNames = new Set<string>(["granola"]);
const resolveAvailableProviderNames = mock(
  async (_db, _tenantId, _wanted: Set<string>) => availableProviderNames,
);
mock.module("../lib/tenant-tools", () => ({
  resolveAvailableProviderNames,
}));

let capabilityAllowed = true;
const capabilityGrantCalls: { provider: string; enabled: boolean }[] = [];
mock.module("../lib/capability-grants", () => ({
  isCapabilityAllowedForPrincipal: async () => capabilityAllowed,
  setPrincipalCapabilityGrant: async (
    _db: unknown,
    args: { provider: string; enabled: boolean },
  ) => {
    capabilityGrantCalls.push({
      provider: args.provider,
      enabled: args.enabled,
    });
  },
}));

import { Hono } from "hono";
const { createMePreferencesRouter } = await import("./me-preferences");

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-1");
    return next();
  });
  v1.route(
    "/",
    createMePreferencesRouter({} as unknown as HubDb, {
      authorize: async () => ({ effect: "allow" }),
    } as never),
  );
  const app = new Hono();
  app.route("/api/v1", v1);
  return app;
}

function patch(body: unknown): Request {
  return new Request("http://localhost/api/v1/me/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-test-user-id": "user-1" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/me/preferences", () => {
  it("returns 403 when enabling an inbox capability the owner has hidden", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    capabilityAllowed = false;
    mergeMemberPreferences.mockClear();
    capabilityGrantCalls.length = 0;
    const res = await mountApp().request(
      patch({ "inbox.capability.linear": true }),
    );
    expect(res.status).toBe(403);
    expect(mergeMemberPreferences).not.toHaveBeenCalled();
    expect(capabilityGrantCalls).toEqual([]);
    capabilityAllowed = true;
  });

  it("merges a valid patch and returns the merged preferences", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    mergeMemberPreferences.mockClear();
    const res = await mountApp().request(patch({ toolSummaryStyle: "mixed" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ theme: "notion", toolSummaryStyle: "mixed" });
    // The parsed patch (not the raw request) is handed to the store.
    expect(mergeMemberPreferences).toHaveBeenCalledTimes(1);
    expect((mergeMemberPreferences.mock.calls[0] as unknown[])[3]).toEqual({
      toolSummaryStyle: "mixed",
    });
  });

  it("returns 400 on an invalid preference value", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    const res = await mountApp().request(patch({ toolSummaryStyle: "fancy" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 when favoriteWorkflows is not a string array", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    const res = await mountApp().request(patch({ favoriteWorkflows: "nope" }));
    expect(res.status).toBe(400);
  });

  it("passes a favoriteWorkflows array through to the store", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    mergeMemberPreferences.mockClear();
    const res = await mountApp().request(
      patch({ favoriteWorkflows: ["a", "b"] }),
    );
    expect(res.status).toBe(200);
    expect((mergeMemberPreferences.mock.calls[0] as unknown[])[3]).toEqual({
      favoriteWorkflows: ["a", "b"],
    });
  });

  it("returns 409 when the caller has no provisioned membership", async () => {
    member = null;
    const res = await mountApp().request(patch({ theme: "tkww" }));
    expect(res.status).toBe(409);
  });

  it("persists a valid registry setting", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    mergeMemberPreferences.mockClear();
    const res = await mountApp().request(
      patch({ agentAutonomy: "execute_with_gates" }),
    );
    expect(res.status).toBe(200);
    expect((mergeMemberPreferences.mock.calls[0] as unknown[])[3]).toEqual({
      agentAutonomy: "execute_with_gates",
    });
  });

  it("returns 400 on an unknown registry key", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    mergeMemberPreferences.mockClear();
    const res = await mountApp().request(patch({ bogusSetting: true }));
    expect(res.status).toBe(400);
    expect(mergeMemberPreferences).not.toHaveBeenCalled();
  });

  it("returns 400 on a wrong-typed registry value", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    mergeMemberPreferences.mockClear();
    const res = await mountApp().request(patch({ briefHourUtc: 99 }));
    expect(res.status).toBe(400);
    expect(mergeMemberPreferences).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/me/preferences/settings", () => {
  function settingsRequest(): Request {
    return new Request("http://localhost/api/v1/me/preferences/settings", {
      headers: { "x-test-user-id": "user-1" },
    });
  }

  it("returns registry entries merged with the caller's stored values", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    readMemberPreferences.mockResolvedValueOnce({
      agentAutonomy: "execute_with_gates",
    });
    const res = await mountApp().request(settingsRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { key: string; value: unknown }[];
    };
    const autonomy = body.settings.find((s) => s.key === "agentAutonomy");
    expect(autonomy?.value).toBe("execute_with_gates");
    const brief = body.settings.find((s) => s.key === "briefHourUtc");
    expect(brief?.value).toBe(13);
  });

  it("returns registry defaults when the caller has no membership", async () => {
    member = null;
    const res = await mountApp().request(settingsRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      settings: { key: string; value: unknown }[];
    };
    expect(body.settings.find((s) => s.key === "agentAutonomy")?.value).toBe(
      "prepare_only",
    );
  });
});

describe("GET /api/v1/me/brief-sources", () => {
  function briefSourcesRequest(): Request {
    return new Request("http://localhost/api/v1/me/brief-sources", {
      headers: { "x-test-user-id": "user-1" },
    });
  }

  it("returns a source whose provider is configured for the tenant", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    availableProviderNames = new Set(["granola"]);
    readMemberPreferences.mockResolvedValueOnce({});
    const res = await mountApp().request(briefSourcesRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: { key: string; enabled: boolean; description: string }[];
    };
    expect(body.sources.map((s) => s.key)).toEqual(["granola"]);
    expect(body.sources[0]?.enabled).toBe(true);
    expect(body.sources[0]?.description).toBe(
      "Call notes from meetings since your last brief.",
    );
  });

  it("omits a source whose provider has no configured credential", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    availableProviderNames = new Set();
    readMemberPreferences.mockResolvedValueOnce({});
    const res = await mountApp().request(briefSourcesRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: unknown[] };
    expect(body.sources).toEqual([]);
  });

  it("returns no sources when the caller has no membership", async () => {
    member = null;
    const res = await mountApp().request(briefSourcesRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sources: [] });
  });

  it("reflects a disabled stored preference", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    availableProviderNames = new Set(["granola"]);
    readMemberPreferences.mockResolvedValueOnce({
      "briefSource:granola": false,
    });
    const res = await mountApp().request(briefSourcesRequest());
    const body = (await res.json()) as { sources: { enabled: boolean }[] };
    expect(body.sources[0]?.enabled).toBe(false);
  });
});

describe("GET /api/v1/me/inbox-sources", () => {
  function inboxSourcesRequest(): Request {
    return new Request("http://localhost/api/v1/me/inbox-sources", {
      headers: { "x-test-user-id": "user-1" },
    });
  }

  it("returns a source whose provider is configured for the tenant, enabled by default", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    availableProviderNames = new Set(["granola"]);
    readMemberPreferences.mockResolvedValueOnce({});
    const res = await mountApp().request(inboxSourcesRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: { key: string; enabled: boolean }[];
    };
    expect(body.sources.map((s) => s.key)).toEqual(["granola"]);
    expect(body.sources[0]?.enabled).toBe(true);
  });

  it("omits a source whose provider has no configured credential", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    availableProviderNames = new Set();
    readMemberPreferences.mockResolvedValueOnce({});
    const res = await mountApp().request(inboxSourcesRequest());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sources: unknown[] };
    expect(body.sources).toEqual([]);
  });

  it("returns no sources when the caller has no membership", async () => {
    member = null;
    const res = await mountApp().request(inboxSourcesRequest());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sources: [] });
  });

  it("reflects a disabled stored preference independent of the brief-source toggle", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    availableProviderNames = new Set(["granola"]);
    readMemberPreferences.mockResolvedValueOnce({
      "inboxSource:granola": false,
      "briefSource:granola": true,
    });
    const res = await mountApp().request(inboxSourcesRequest());
    const body = (await res.json()) as { sources: { enabled: boolean }[] };
    expect(body.sources[0]?.enabled).toBe(false);

    readMemberPreferences.mockResolvedValueOnce({
      "inboxSource:granola": false,
      "briefSource:granola": true,
    });
    const briefRes = await mountApp().request(
      new Request("http://localhost/api/v1/me/brief-sources", {
        headers: { "x-test-user-id": "user-1" },
      }),
    );
    const briefBody = (await briefRes.json()) as {
      sources: { enabled: boolean }[];
    };
    expect(briefBody.sources[0]?.enabled).toBe(true);
  });
});

describe("GET /api/v1/me/preferences", () => {
  it("returns the stored preferences for the caller", async () => {
    member = { tenantId: "ten-1", principalId: "pri-1" };
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/preferences", {
        headers: { "x-test-user-id": "user-1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: "notion" });
  });

  it("returns an empty object when the caller has no membership", async () => {
    member = null;
    const res = await mountApp().request(
      new Request("http://localhost/api/v1/me/preferences", {
        headers: { "x-test-user-id": "user-1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});
