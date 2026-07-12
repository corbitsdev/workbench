import { afterEach, describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

let resolveResult: { providerId: string; secret: string } | null = null;
let resolveError: Error | null = null;

mock.module("@intx/db", () => ({
  resolveCredentialRequirement: async () => {
    if (resolveError) throw resolveError;
    return resolveResult;
  },
}));

const { resolveAdapterCredential } = await import("./task-credential");

function dbWithProvider(metadata: unknown): HubDb {
  return {
    query: {
      provider: { findFirst: async () => ({ id: "prv-1", metadata }) },
    },
  } as unknown as HubDb;
}

afterEach(() => {
  resolveResult = null;
  resolveError = null;
});

describe("resolveAdapterCredential", () => {
  it("returns null when no credential resolves (not-found)", async () => {
    resolveResult = null;
    const resolve = resolveAdapterCredential({} as HubDb);
    expect(await resolve("attio", "ten-1")).toBeNull();
  });

  it("propagates a resolver error instead of swallowing it", async () => {
    resolveError = new Error("Ambiguous credential match");
    const resolve = resolveAdapterCredential({} as HubDb);
    await expect(resolve("attio", "ten-1")).rejects.toThrow(
      "Ambiguous credential match",
    );
  });

  it("returns the secret and baseURL from provider metadata", async () => {
    resolveResult = { providerId: "prv-1", secret: "sk-123" };
    const resolve = resolveAdapterCredential(
      dbWithProvider({ baseURL: "https://api.example.com" }),
    );
    expect(await resolve("attio", "ten-1")).toEqual({
      apiKey: "sk-123",
      baseURL: "https://api.example.com",
    });
  });

  it("defaults baseURL to empty when metadata has none", async () => {
    resolveResult = { providerId: "prv-1", secret: "sk-123" };
    const resolve = resolveAdapterCredential(dbWithProvider({ other: 1 }));
    expect(await resolve("attio", "ten-1")).toEqual({
      apiKey: "sk-123",
      baseURL: "",
    });
  });

  it("defaults baseURL to empty when metadata baseURL is malformed", async () => {
    resolveResult = { providerId: "prv-1", secret: "sk-123" };
    const resolve = resolveAdapterCredential(dbWithProvider({ baseURL: 42 }));
    expect((await resolve("attio", "ten-1"))?.baseURL).toBe("");
  });
});
