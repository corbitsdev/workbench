/// <reference types="bun" />
import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { AgentTool } from "@intx/agent";
import type { IdentityAccount } from "../lib/member-identity";

type Row = Record<string, unknown>;

// Mock the store and the owner resolver at the module boundary so these tests
// exercise the handler logic (compact vs full, owner-scoping, fail-closed)
// without re-mocking drizzle internals.
const resolveOwner = mock<(...a: unknown[]) => Promise<string | null>>(
  async () => "mem_owner",
);
const getAccounts = mock<(...a: unknown[]) => Promise<IdentityAccount[]>>(
  async () => [],
);
const setAccount = mock<(...a: unknown[]) => Promise<IdentityAccount>>(
  async () => ({
    provider: "linear",
    value: "u1",
    label: null,
    isPrimary: false,
    metadata: {},
  }),
);

mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId: resolveOwner,
}));
mock.module("../lib/member-identity", () => ({
  getIdentityAccounts: getAccounts,
  setIdentityAccount: setAccount,
}));

const { createIdentityTools } = await import("./identity");

const SIGNAL = new AbortController().signal;
const CONTEXT = { db: {} as never, tenantId: "tnt", principalId: "prn" };

function tools() {
  const [get, set] = createIdentityTools(CONTEXT);
  if (!get || !set) throw new Error("expected get and set tools");
  const run = (tool: AgentTool, args: Row) =>
    (tool.handler as (a: Row, s: AbortSignal) => Promise<string>)(args, SIGNAL);
  return { get: (a: Row) => run(get, a), set: (a: Row) => run(set, a) };
}

beforeEach(() => {
  resolveOwner.mockReset();
  resolveOwner.mockImplementation(async () => "mem_owner");
  getAccounts.mockReset();
  getAccounts.mockImplementation(async () => []);
  setAccount.mockReset();
  setAccount.mockImplementation(async () => ({
    provider: "linear",
    value: "u1",
    label: null,
    isPrimary: false,
    metadata: {},
  }));
});

describe("identity_get", () => {
  it("returns full accounts for the requested providers", async () => {
    getAccounts.mockImplementation(async () => [
      {
        provider: "linear",
        value: "lin_123",
        label: "Work",
        isPrimary: true,
        metadata: { workspace: "acme" },
      },
    ]);
    const result = JSON.parse(await tools().get({ providers: ["linear"] })) as {
      accounts: IdentityAccount[];
    };
    expect(result.accounts[0]!.value).toBe("lin_123");
    const call = getAccounts.mock.calls[0]!;
    expect(call[1]).toBe("tnt");
    expect(call[2]).toBe("mem_owner");
    expect(call[3]).toEqual(["linear"]);
  });

  it("returns a compact index (labels, no values) when no providers are given", async () => {
    getAccounts.mockImplementation(async () => [
      {
        provider: "linear",
        value: "lin_secret",
        label: "Work",
        isPrimary: true,
        metadata: {},
      },
      {
        provider: "linear",
        value: "lin_other",
        label: "Personal",
        isPrimary: false,
        metadata: {},
      },
    ]);
    const raw = await tools().get({});
    expect(raw).not.toContain("lin_secret");
    const result = JSON.parse(raw) as {
      providers: { provider: string; accounts: { label: string }[] }[];
    };
    expect(result.providers[0]!.provider).toBe("linear");
    expect(result.providers[0]!.accounts.map((a) => a.label)).toEqual([
      "Work",
      "Personal",
    ]);
  });

  it("returns empty when the agent has no owning user", async () => {
    resolveOwner.mockImplementation(async () => null);
    const result = JSON.parse(await tools().get({}));
    expect(result).toEqual({ providers: [] });
  });

  it("rejects a non-array providers argument", async () => {
    await expect(tools().get({ providers: "linear" })).rejects.toThrow(
      /providers must be an array/,
    );
  });
});

describe("identity_set", () => {
  it("caches an account scoped to the resolved owner", async () => {
    setAccount.mockImplementation(async () => ({
      provider: "linear",
      value: "lin_9",
      label: "Work",
      isPrimary: true,
      metadata: {},
    }));
    const result = JSON.parse(
      await tools().set({
        provider: "linear",
        value: "lin_9",
        label: "Work",
        primary: true,
      }),
    ) as { ok: boolean; account: IdentityAccount };
    expect(result.ok).toBe(true);
    expect(result.account.value).toBe("lin_9");
    const call = setAccount.mock.calls[0]!;
    expect(call[1]).toBe("tnt");
    expect(call[2]).toBe("mem_owner");
    expect(call[3]).toMatchObject({
      provider: "linear",
      value: "lin_9",
      primary: true,
    });
  });

  it("fails closed when the agent has no owning user", async () => {
    resolveOwner.mockImplementation(async () => null);
    await expect(
      tools().set({ provider: "linear", value: "x" }),
    ).rejects.toThrow(/no owning user/);
  });

  it("requires provider and value", async () => {
    await expect(tools().set({ provider: "linear" })).rejects.toThrow(
      /value is required/,
    );
  });
});
