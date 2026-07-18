import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { GrantStore } from "@intx/authz";
import { INBOX_SOURCE_CATALOG } from "@workbench/shared";

// CL-3584: owner GET/PUT for tenant-wide inbox source enablement. Mirrors the
// owner feature routes; the guard runs for real over a fake grant store.

let callerPrincipalId = "prn_member";
mock.module("../lib/tenant-provisioning", () => ({
  ensureMember: async () => ({
    tenantId: "ten_root",
    principalId: callerPrincipalId,
  }),
}));

// CL-3629: the Slack-enable branch resolves a bot credential, calls
// auth.test for the team id, and (best-effort) sweeps public channels. Mock
// all three at the module boundary so these tests never hit the network;
// `upsertSlackTeamMappingCalls` is asserted against directly.
const FAKE_SLACK_CREDENTIAL = {
  botToken: "xoxb-fake",
  baseUrl: "https://slack.example/api",
};
let slackCredentialResult: typeof FAKE_SLACK_CREDENTIAL | null =
  FAKE_SLACK_CREDENTIAL;
let slackTeamIdResult: string | null = "T0TEAM";
const upsertSlackTeamMappingCalls: { tenantId: string; slackTeamId: string }[] =
  [];
mock.module("../lib/slack-api-client", () => ({
  resolveSlackCredential: async () => slackCredentialResult,
  fetchSlackTeamId: async () => slackTeamIdResult,
}));
mock.module("../lib/slack-team-mapping", () => ({
  upsertSlackTeamMapping: async (
    _db: unknown,
    tenantId: string,
    slackTeamId: string,
  ) => {
    upsertSlackTeamMappingCalls.push({ tenantId, slackTeamId });
  },
}));
mock.module("../lib/slack-channel-autojoin", () => ({
  joinAllPublicChannels: async () => {},
}));

const { createOwnerRouter } = await import("./owner");

function grantStoreFor(): GrantStore {
  return {
    collectGrants: async (principalId: string) => {
      if (principalId === "prn_owner") {
        return [
          {
            id: "grt_owner",
            resource: "*",
            action: "*",
            effect: "allow" as const,
            origin: "system",
            conditions: null,
            expiresAt: null,
            roleId: null,
            principalId,
          },
        ];
      }
      return [];
    },
  } as unknown as GrantStore;
}

function ownerDb(opts: { enabledSources?: string[] } = {}) {
  const memberRole = { id: "rol_member" };
  const enabled = new Set(opts.enabledSources ?? []);
  const grantRows = [...enabled].map((key) => ({
    id: `grt_${key}`,
    resource: `inbox-source:${key}`,
    action: "enable",
    effect: "allow" as const,
    origin: "system",
    conditions: null,
    expiresAt: null,
    roleId: "rol_member",
    principalId: null,
  }));
  const insertedGrants: Record<string, unknown>[] = [];
  let deleteCalls = 0;

  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ for: async () => [] }) }),
    }),
    query: {
      grant: {
        findFirst: async () => grantRows[0],
      },
    },
    delete: () => ({
      where: () => {
        deleteCalls += 1;
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (vals: Record<string, unknown>) => {
        insertedGrants.push(vals);
        return Promise.resolve();
      },
    }),
  };

  const db = {
    query: {
      role: {
        findMany: async () => [memberRole],
        findFirst: async () => memberRole,
      },
      grant: {
        findMany: async () => grantRows,
      },
    },
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    insert: () => ({ values: () => Promise.resolve() }),
  };
  return { db, insertedGrants, deleteCalls: () => deleteCalls };
}

function buildApp(db: unknown) {
  const app = new Hono<{
    Variables: { userId: string; ownerPrincipalId: string };
  }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createOwnerRouter({
      db: db as never,
      grantStore: grantStoreFor(),
      sidecarRouter: {} as never,
      rootTenantId: "ten_root",
      showDemos: false,
      featureEnvOverrides: {
        scheduler: false,
        triage: false,
        "tasks-reconciler": false,
      },
    }),
  );
  return app;
}

beforeEach(() => {
  callerPrincipalId = "prn_member";
  slackCredentialResult = FAKE_SLACK_CREDENTIAL;
  slackTeamIdResult = "T0TEAM";
  upsertSlackTeamMappingCalls.length = 0;
});

describe("owner inbox-sources routes", () => {
  const sampleKey = INBOX_SOURCE_CATALOG[0]?.key ?? "granola";

  it("denies a plain member with 403", async () => {
    const { db } = ownerDb();
    const res = await buildApp(db).request("/owner/inbox-sources");
    expect(res.status).toBe(403);
  });

  it("GET lists the full catalog, disabled by default", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = ownerDb();
    const res = await buildApp(db).request("/owner/inbox-sources");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sources: { key: string; enabled: boolean }[];
    };
    expect(body.sources.map((s) => s.key).sort()).toEqual(
      INBOX_SOURCE_CATALOG.map((s) => s.key).sort(),
    );
    expect(body.sources.every((s) => !s.enabled)).toBe(true);
  });

  it("GET reports a source enabled when its member-role grant exists", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = ownerDb({ enabledSources: [sampleKey] });
    const res = await buildApp(db).request("/owner/inbox-sources");
    const body = (await res.json()) as {
      sources: { key: string; enabled: boolean }[];
    };
    expect(body.sources.find((s) => s.key === sampleKey)?.enabled).toBe(true);
  });

  it("PUT enable writes an allow grant for the named source", async () => {
    callerPrincipalId = "prn_owner";
    const { db, insertedGrants } = ownerDb();
    const res = await buildApp(db).request(
      `/owner/inbox-sources/${sampleKey}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ key: sampleKey, enabled: true });
    expect(insertedGrants[0]).toMatchObject({
      resource: `inbox-source:${sampleKey}`,
      action: "enable",
      effect: "allow",
    });
  });

  it("PUT disable removes the existing grant", async () => {
    callerPrincipalId = "prn_owner";
    const { db, deleteCalls } = ownerDb({ enabledSources: [sampleKey] });
    const res = await buildApp(db).request(
      `/owner/inbox-sources/${sampleKey}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(res.status).toBe(200);
    expect(deleteCalls()).toBe(1);
  });

  it("PUT returns 404 for an unknown source key", async () => {
    callerPrincipalId = "prn_owner";
    const { db } = ownerDb();
    const res = await buildApp(db).request(
      "/owner/inbox-sources/not-a-source",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(res.status).toBe(404);
  });

  describe("Slack team_id → tenant mapping (CL-3629)", () => {
    it("PUT enable resolves the team id and writes the tenant mapping", async () => {
      callerPrincipalId = "prn_owner";
      const { db } = ownerDb();
      const res = await buildApp(db).request("/owner/inbox-sources/slack", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(upsertSlackTeamMappingCalls).toEqual([
        { tenantId: "ten_root", slackTeamId: "T0TEAM" },
      ]);
    });

    it("PUT disable does not touch the team mapping", async () => {
      callerPrincipalId = "prn_owner";
      const { db } = ownerDb({ enabledSources: ["slack"] });
      const res = await buildApp(db).request("/owner/inbox-sources/slack", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);
      expect(upsertSlackTeamMappingCalls).toEqual([]);
    });

    it("enabling a non-Slack source does not touch the team mapping", async () => {
      callerPrincipalId = "prn_owner";
      const { db } = ownerDb();
      const res = await buildApp(db).request(
        `/owner/inbox-sources/${sampleKey}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(res.status).toBe(200);
      expect(upsertSlackTeamMappingCalls).toEqual([]);
    });

    it("auth.test returning no team_id records no mapping (enablement still succeeds)", async () => {
      callerPrincipalId = "prn_owner";
      slackTeamIdResult = null;
      const { db } = ownerDb();
      const res = await buildApp(db).request("/owner/inbox-sources/slack", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(upsertSlackTeamMappingCalls).toEqual([]);
    });

    it("no Slack credential means no mapping is written (enablement still succeeds)", async () => {
      callerPrincipalId = "prn_owner";
      slackCredentialResult = null;
      const { db } = ownerDb();
      const res = await buildApp(db).request("/owner/inbox-sources/slack", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(res.status).toBe(200);
      expect(upsertSlackTeamMappingCalls).toEqual([]);
    });
  });
});
