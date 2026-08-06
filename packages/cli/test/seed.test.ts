import { describe, expect, test } from "bun:test";
import { CliError } from "@workbench/hub-client";
import type { SeedConfig } from "../src/config";
import { runSeed, type SeedDeps } from "../src/seed";
import {
  collector,
  fakeAPI,
  principalsResponse,
  signUpResponse,
  tenantRow,
  TENANT_ID,
  type FakeHandler,
} from "./helpers";

const CONFIG: SeedConfig = {
  hubUrl: "http://localhost:3000",
  adminEmail: "admin@example.com",
  adminPassword: "password123",
  orgSlug: "workbench",
  modelSource: {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    baseURL: "https://api.anthropic.com/v1",
    apiKey: "sk-test",
  },
};

function deps(overrides: Partial<SeedDeps> & Pick<SeedDeps, "api">): SeedDeps {
  const { log } = collector();
  return {
    config: CONFIG,
    pushWorkflow: async () => "pushed",
    log,
    ...overrides,
  };
}

describe("runSeed", () => {
  test("authenticates, resolves the bench by slug, and starts seeding it", async () => {
    const { lines, log } = collector();
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return principalsResponse();
      if (method === "GET" && path === `/api/tenants/${TENANT_ID}`)
        return { status: 200, data: tenantRow() };
      if (
        method === "GET" &&
        path.startsWith(`/api/tenants/${TENANT_ID}/grants?`)
      )
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    };

    // Resolving the bench succeeds and hands off into seedTenant; the
    // very next unhandled call (planting the first seed grant) proves
    // the handoff happened without re-testing seedTenant's own
    // mechanics, which belong to @workbench/hub-client.
    expect(runSeed(deps({ api: fakeAPI(handler), log }))).rejects.toThrow(
      /unexpected hub call/,
    );
    expect(lines.join("\n")).toContain(
      `seeding bench workbench (${TENANT_ID})`,
    );
  });

  test("a missing bench points at workbench setup", async () => {
    const handler: FakeHandler = (method, path) => {
      if (method === "POST" && path === "/api/auth/sign-up/email")
        return signUpResponse();
      if (method === "GET" && path === "/api/me/principals")
        return { status: 200, data: { data: [], nextCursor: null } };
      return undefined;
    };

    let caught: unknown;
    try {
      await runSeed(deps({ api: fakeAPI(handler) }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).fix).toContain("workbench setup");
  });
});
