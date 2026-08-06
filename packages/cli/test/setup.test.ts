import { describe, expect, test } from "bun:test";
import type { SetupConfig } from "../src/config";
import { CliError } from "@workbench/hub-client";
import { runSetup } from "../src/setup";
import {
  collector,
  fakeAPI,
  principalsResponse,
  rolesResponse,
  signUpResponse,
  tenantRow,
  TENANT_ID,
} from "./helpers";

const CONFIG: SetupConfig = {
  hubUrl: "http://localhost:3000",
  adminEmail: "admin@example.com",
  adminPassword: "password123",
  orgName: "Workbench",
  orgSlug: "workbench",
};

const okDbSetup = async () => {};

describe("runSetup", () => {
  test("fresh run initializes, provisions, and reports what remains", async () => {
    const { lines, log } = collector();
    let dbSetupRuns = 0;
    const api = fakeAPI((method, path) => {
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
      log,
    });

    expect(dbSetupRuns).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("created administrator admin@example.com");
    expect(output).toContain("created bench workbench");
    expect(output).toContain("role defaults in place: admin, member, owner");
    expect(output).toContain("WORKBENCH_MODEL_API_KEY");
    expect(output).toContain("workbench seed");
  });

  test("re-run reports skips instead of duplicating", async () => {
    const { lines, log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return { status: 422, data: { error: "already registered" } };
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

    await runSetup({ config: CONFIG, api, runDbSetup: okDbSetup, log });

    const output = lines.join("\n");
    expect(output).toContain(
      "administrator admin@example.com already exists (skipped)",
    );
    expect(output).toContain("bench workbench already exists (skipped)");
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
      runSetup({ config: CONFIG, api, runDbSetup: failing, log }),
    ).rejects.toThrow("database initialization failed");
  });

  test("zero platform roles is an error, never a silent success", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
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
      runSetup({ config: CONFIG, api, runDbSetup: okDbSetup, log }),
    ).rejects.toThrow(/zero roles/);
  });

  test("a wrong password for an existing administrator names the variable to fix", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return { status: 422, data: {} };
      if (method === "POST" && path === "/api/auth/sign-in/email")
        return { status: 401, data: {} };
      return undefined;
    });

    let caught: unknown;
    try {
      await runSetup({ config: CONFIG, api, runDbSetup: okDbSetup, log });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("WORKBENCH_ADMIN_PASSWORD");
  });

  test("an unresolvable tenant conflict fails with the failing status", async () => {
    const { log } = collector();
    const api = fakeAPI((method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "POST" && path === "/api/tenants")
        return { status: 409, data: { error: "slug taken" } };
      if (method === "GET" && path === "/api/me/principals")
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    });

    expect(
      runSetup({ config: CONFIG, api, runDbSetup: okDbSetup, log }),
    ).rejects.toThrow(/status 409/);
  });
});
