import { describe, expect, test } from "bun:test";

import type { ClientLogger } from "@corbits/client-log";

import {
  bootstrapClientSession,
  logBootstrapResult,
  logBootstrapThrown,
} from "./client-bootstrap";
import type { ClientBootstrapResult } from "./client-bootstrap";
import type { StockHub } from "./needs-converge";

function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}

test("session bootstrap drives the portable client manifest", async () => {
  const calls: string[] = [];
  const hub: StockHub = {
    listMyPrincipals: () => {
      calls.push("listMyPrincipals");
      return Promise.resolve([
        {
          principalId: "prn_user",
          tenantId: "tnt_primary",
          tenantName: "Ada",
          tenantSlug: "ada",
          kind: "user",
          status: "active",
          roles: [{ id: "role_owner", name: "owner" }],
        },
      ]);
    },
    getTenant: (id) => {
      calls.push(`getTenant:${id}`);
      return Promise.resolve({
        id,
        name: "Ada",
        slug: "ada",
        parentId: null,
      });
    },
    listPrincipals: (tenantId) => {
      calls.push(`listPrincipals:${tenantId}`);
      return Promise.resolve([
        {
          id: "prn_user",
          tenantId,
          kind: "user",
          refId: "usr_1",
          displayName: "Ada",
          email: "ada@example.com",
          status: "active",
          roles: [{ id: "role_owner", name: "owner" }],
        },
        {
          id: "prn_myra",
          tenantId,
          kind: "workflow",
          refId: "assistant",
          displayName: "Myra",
          status: "active",
          roles: [],
        },
      ]);
    },
    createTenant: () => Promise.reject(new Error("unexpected create")),
    inviteMember: () => Promise.reject(new Error("unexpected invite")),
    deployWorkflow: () => Promise.reject(new Error("unexpected deploy")),
  };

  const result = await bootstrapClientSession(
    { id: "usr_1", name: "Ada", email: "ada@example.com" },
    {
      hub,
      storage: memoryStorage(),
      hubScope: "https://hub.example",
    },
  );

  expect(result).toMatchObject({
    kind: "error",
    code: "stock-capability-missing",
    capability: "project-workflow-principal",
  });
  expect(calls).toEqual([
    "listMyPrincipals",
    "getTenant:tnt_primary",
    "listPrincipals:tnt_primary",
  ]);
});

describe("logBootstrapResult", () => {
  function recordingLogger() {
    const entries: { level: string; message: string; data?: unknown }[] = [];
    const log: ClientLogger = {
      debug: () => undefined,
      info: (message, data) => {
        entries.push({ level: "info", message, data });
      },
      warn: (message, data) => {
        entries.push({ level: "warn", message, data });
      },
      error: () => undefined,
    };
    return { log, entries };
  }

  test("logs ready at info with the converged ids", () => {
    const { log, entries } = recordingLogger();
    logBootstrapResult(log, {
      kind: "ready",
      primaryTenantId: "tnt_primary",
      createdTenantIds: ["tnt_atlas"],
      directMessages: [],
    });
    expect(entries).toEqual([
      {
        level: "info",
        message: "Portable client bootstrap converged",
        data: {
          primaryTenantId: "tnt_primary",
          createdTenantIds: ["tnt_atlas"],
        },
      },
    ]);
  });

  test("logs a stock gap at warn with its capability note", () => {
    const { log, entries } = recordingLogger();
    const result: ClientBootstrapResult = {
      kind: "error",
      code: "stock-capability-missing",
      capability: "project-workflow-principal",
      message: "cannot project",
      gap: "needs upstream work",
    };
    logBootstrapResult(log, result);
    expect(entries).toEqual([
      {
        level: "warn",
        message: "Portable client bootstrap waiting on stock capability",
        data: {
          capability: "project-workflow-principal",
          gap: "needs upstream work",
        },
      },
    ]);
  });

  test("logs other failures and thrown errors at warn, never throwing", () => {
    const { log, entries } = recordingLogger();
    logBootstrapResult(log, {
      kind: "error",
      code: "client-config-missing",
      message: "no Myra entry",
    });
    logBootstrapThrown(log, new Error("boom"));
    logBootstrapThrown(log, "bare string");
    expect(entries).toEqual([
      {
        level: "warn",
        message: "Portable client bootstrap failed",
        data: { message: "no Myra entry" },
      },
      {
        level: "warn",
        message: "Portable client bootstrap threw",
        data: { message: "boom" },
      },
      {
        level: "warn",
        message: "Portable client bootstrap threw",
        data: { message: "bare string" },
      },
    ]);
  });
});
