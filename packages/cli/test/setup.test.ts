import { describe, expect, test } from "bun:test";
import type { SetupConfig } from "../src/config";
import { CliError } from "@workbench/hub-client";
import { runSetup } from "../src/setup";
import {
  collector,
  fakeAPI,
  principalsResponse,
  rolesResponse,
  signInMissing,
  signUpResponse,
  tenantRow,
  TENANT_ID,
} from "./helpers";

const CONFIG: SetupConfig = {
  hubUrl: "http://localhost:3000",
  adminDefaulted: false,
  adminEmail: "admin@example.com",
  adminPassword: "password123",
  orgName: "Workbench",
  orgSlug: "workbench",
};

const okDbSetup = async () => {};
const noopPublishToolRegistry = async () => undefined;

describe("runSetup", () => {
  test("fresh run initializes, provisions, and reports what remains", async () => {
    const { lines, log } = collector();
    let dbSetupRuns = 0;
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 201, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    await runSetup({
      config: CONFIG,
      api,
      runDbSetup: async () => {
        dbSetupRuns += 1;
      },
      publishToolRegistry: noopPublishToolRegistry,
      log,
    });

    expect(dbSetupRuns).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("created administrator admin@example.com");
    expect(output).toContain("created bench workbench");
    expect(output).toContain(
      `published the platform corbits-tools registry onto bench workbench (${TENANT_ID})`,
    );
    expect(output).toContain("role defaults in place: admin, member, owner");
    expect(output).toContain("ANTHROPIC_API_KEY");
    expect(output).toContain("workbench seed");
  });

  test("re-run reports skips instead of duplicating", async () => {
    const { lines, log } = collector();
    const publishCalls: { tenantId: string }[] = [];
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 409, data: { error: "slug taken" } };
      if (method === "GET" && path === "/api/me/principals")
        return principalsResponse();
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    await runSetup({
      config: CONFIG,
      api,
      runDbSetup: okDbSetup,
      publishToolRegistry: async (args) => {
        publishCalls.push({ tenantId: args.tenantId });
        return [];
      },
      log,
    });

    expect(publishCalls).toEqual([{ tenantId: TENANT_ID }]);

    const output = lines.join("\n");
    expect(output).toContain(
      "administrator admin@example.com already exists (skipped)",
    );
    expect(output).toContain("bench workbench already exists (skipped)");
    expect(output).toContain(
      "platform corbits-tools registry already on bench workbench (skipped)",
    );
  });

  test("a database initialization failure stops the run before any hub call", async () => {
    const { log } = collector();
    const api = fakeAPI(() => {
      throw new Error("the hub must not be called when the database fails");
    });
    const failing = async () => {
      throw new CliError("database initialization failed", "start Postgres");
    };
    expect(
      runSetup({
        config: CONFIG,
        api,
        runDbSetup: failing,
        publishToolRegistry: noopPublishToolRegistry,
        log,
      }),
    ).rejects.toThrow("database initialization failed");
  });

  test("zero platform roles is an error, never a silent success", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 201, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse([]);
      return undefined;
    });

    expect(
      runSetup({
        config: CONFIG,
        api,
        runDbSetup: okDbSetup,
        publishToolRegistry: noopPublishToolRegistry,
        log,
      }),
    ).rejects.toThrow(/zero roles/);
  });

  test("a wrong password for an existing administrator names the variable to fix", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return { status: 401, data: {} };
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return { status: 422, data: {} };
      return undefined;
    });

    let caught: unknown;
    try {
      await runSetup({
        config: CONFIG,
        api,
        runDbSetup: okDbSetup,
        publishToolRegistry: noopPublishToolRegistry,
        log,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("HUB_ADMIN_PASSWORD");
  });

  test("an unverified-email signup rejection names the ALLOW_UNVERIFIED_EMAILS fix", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return {
          status: 403,
          data: {
            error: {
              code: "signup_not_allowed",
              message:
                "This account's email address isn't verified, and this hub requires verified emails before provisioning.",
            },
          },
        };
      if (method === "GET" && path === "/api/me/principals")
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    });

    let caught: unknown;
    try {
      await runSetup({
        config: CONFIG,
        api,
        runDbSetup: okDbSetup,
        publishToolRegistry: noopPublishToolRegistry,
        log,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain("isn't verified");
    expect((caught as CliError).fix).toContain("ALLOW_UNVERIFIED_EMAILS=1");
  });

  test("an unresolvable tenant conflict fails with the failing status", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 409, data: { error: "slug taken" } };
      if (method === "GET" && path === "/api/me/principals")
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    });

    expect(
      runSetup({
        config: CONFIG,
        api,
        runDbSetup: okDbSetup,
        publishToolRegistry: noopPublishToolRegistry,
        log,
      }),
    ).rejects.toThrow(/status 409/);
  });

  test("publishes corbits-tools onto the created tenant", async () => {
    const { log } = collector();
    const calls: { tenantId: string; hubUrl: string }[] = [];
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 201, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    await runSetup({
      config: CONFIG,
      api,
      runDbSetup: okDbSetup,
      publishToolRegistry: async (args) => {
        calls.push({ tenantId: args.tenantId, hubUrl: args.hubUrl });
        return [
          {
            filename: "memory-tools-0.0.0.tgz",
            commit: "c",
            integrity: "i",
          },
        ];
      },
      log,
    });

    expect(calls).toEqual([{ tenantId: TENANT_ID, hubUrl: CONFIG.hubUrl }]);
  });

  test("a publisher throw is a setup CliError, not a seed error", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 201, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    let caught: unknown;
    try {
      await runSetup({
        config: CONFIG,
        api,
        runDbSetup: okDbSetup,
        publishToolRegistry: async () => {
          throw new Error("src/ changed without bumping version");
        },
        log,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain(
      "publishing the corbits-tools package-registry asset failed",
    );
    expect((caught as CliError).fix).toContain("workbench setup");
    expect((caught as CliError).fix).not.toContain("workbench seed");
  });

  test("writes OPERATOR_TENANT_ID for the org tenant it created", async () => {
    const { log } = collector();
    const persisted: { key: string; value: string }[] = [];
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 201, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    await runSetup({
      config: CONFIG,
      api,
      runDbSetup: okDbSetup,
      publishToolRegistry: noopPublishToolRegistry,
      persistEnv: async (args) => {
        persisted.push(args);
      },
      log,
    });

    expect(persisted).toEqual([
      { key: "OPERATOR_TENANT_ID", value: TENANT_ID },
    ]);
  });

  test("a re-run still writes OPERATOR_TENANT_ID for the existing org tenant", async () => {
    const { log } = collector();
    const persisted: { key: string; value: string }[] = [];
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 409, data: { error: "slug taken" } };
      if (method === "GET" && path === "/api/me/principals")
        return principalsResponse();
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    await runSetup({
      config: CONFIG,
      api,
      runDbSetup: okDbSetup,
      publishToolRegistry: async () => [],
      persistEnv: async (args) => {
        persisted.push(args);
      },
      log,
    });

    expect(persisted).toEqual([
      { key: "OPERATOR_TENANT_ID", value: TENANT_ID },
    ]);
  });

  test("a persistEnv failure is a setup CliError", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return signInMissing();
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 201, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/roles`)
      )
        return rolesResponse(["owner", "admin", "member"]);
      return undefined;
    });

    let caught: unknown;
    try {
      await runSetup({
        config: CONFIG,
        api,
        runDbSetup: okDbSetup,
        publishToolRegistry: noopPublishToolRegistry,
        persistEnv: async () => {
          throw new Error(".env is not writable");
        },
        log,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).message).toContain("OPERATOR_TENANT_ID");
    expect((caught as CliError).fix).toContain(".env");
  });
});
