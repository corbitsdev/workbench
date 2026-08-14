import { describe, expect, test, beforeEach, mock } from "bun:test";

// createAutoProvisionPrincipalResolver's whole job is a policy decision on
// top of a read-only base resolver: which non-ok findings get a second
// chance via auto-provisioning, and which get declined outright. These
// tests drive that decision from the base resolver's every documented
// `UnresolvedReason`, mocking `corbits-tag/interchange` so each case is
// exercised without a real database.

type StubResolution =
  | {
      ok: true;
      principal: {
        principalId: string;
        tenantId: string;
        userId: string;
        email: string;
      };
    }
  | {
      ok: false;
      reason: string;
      tenantId: string | undefined;
      email: string | undefined;
    };

type ProvisionCall = {
  tenantId: string;
  email: string;
  name: string;
  roles?: readonly string[];
};

let nextResolution: StubResolution;
let provisionCalls: ProvisionCall[];
let provisionShouldThrow: boolean;
let tenantLookupResult: { id: string; slug: string } | undefined;

mock.module("corbits-tag/interchange", () => ({
  createPrincipalResolver: () => async () => nextResolution,
  provisionPrincipal: async (_db: unknown, input: ProvisionCall) => {
    provisionCalls.push(input);
    if (provisionShouldThrow) throw new Error("provisioning boom");
    return {
      principalId: "prn_auto",
      tenantId: input.tenantId,
      userId: "usr_auto",
      email: input.email,
    };
  },
}));

const fakeDb = {
  query: {
    tenant: {
      findFirst: async () => tenantLookupResult,
    },
  },
} as never;

beforeEach(() => {
  provisionCalls = [];
  provisionShouldThrow = false;
  tenantLookupResult = { id: "tenant_1", slug: "acme" };
});

async function resolver(roleNames: readonly string[] = ["member"]) {
  const { createAutoProvisionPrincipalResolver } = await import(
    "./principal-resolver"
  );
  return createAutoProvisionPrincipalResolver(fakeDb, "acme", roleNames);
}

describe("createAutoProvisionPrincipalResolver", () => {
  test("passes an already-ok resolution straight through", async () => {
    nextResolution = {
      ok: true,
      principal: {
        principalId: "prn_x",
        tenantId: "tenant_1",
        userId: "usr_x",
        email: "known@example.com",
      },
    };

    const resolve = await resolver();
    const result = await resolve({
      userId: "U1",
      email: "known@example.com",
      emailVerified: true,
      isRestricted: false,
      isBot: false,
    });

    expect(result).toEqual(nextResolution);
    expect(provisionCalls).toHaveLength(0);
  });

  test("declines a bot author without provisioning", async () => {
    nextResolution = {
      ok: false,
      reason: "bot_author",
      tenantId: "tenant_1",
      email: undefined,
    };

    const resolve = await resolver();
    const result = await resolve({
      userId: "B1",
      email: undefined,
      emailVerified: "unknown",
      isRestricted: false,
      isBot: true,
    });

    expect(provisionCalls).toHaveLength(0);
    expect(result).toEqual(nextResolution);
  });

  test("declines a restricted (guest / shared-channel) Slack author without provisioning", async () => {
    nextResolution = {
      ok: false,
      reason: "restricted_author",
      tenantId: "tenant_1",
      email: "guest@example.com",
    };

    const resolve = await resolver();
    const result = await resolve({
      userId: "U_GUEST",
      email: "guest@example.com",
      emailVerified: true,
      isRestricted: true,
      isBot: false,
    });

    expect(provisionCalls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("restricted_author");
  });

  for (const reason of [
    "lookup_failed",
    "not_a_member",
    "principal_inactive",
    "tenant_not_found",
  ]) {
    test(`declines "${reason}" without provisioning`, async () => {
      nextResolution = {
        ok: false,
        reason,
        tenantId: "tenant_1",
        email: "person@example.com",
      };

      const resolve = await resolver();
      const result = await resolve(
        reason === "lookup_failed"
          ? null
          : {
              userId: "U1",
              email: "person@example.com",
              emailVerified: true,
              isRestricted: false,
              isBot: false,
            },
      );

      expect(provisionCalls).toHaveLength(0);
      expect(result).toEqual(nextResolution);
    });
  }

  test("auto-provisions on first contact when the base resolver reports no_account", async () => {
    nextResolution = {
      ok: false,
      reason: "no_account",
      tenantId: "tenant_1",
      email: "newperson@example.com",
    };

    const resolve = await resolver(["member"]);
    const result = await resolve({
      userId: "U2",
      email: "newperson@example.com",
      emailVerified: true,
      isRestricted: false,
      isBot: false,
    });

    expect(provisionCalls).toEqual([
      {
        tenantId: "tenant_1",
        email: "newperson@example.com",
        name: "U2",
        roles: ["member"],
      },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.principal.email).toBe("newperson@example.com");
  });

  test("auto-provisions with a synthetic email when the author has no readable email", async () => {
    nextResolution = {
      ok: false,
      reason: "no_email",
      tenantId: "tenant_1",
      email: undefined,
    };

    const resolve = await resolver();
    const result = await resolve({
      userId: "U9",
      email: undefined,
      emailVerified: "unknown",
      isRestricted: false,
      isBot: false,
    });

    expect(provisionCalls).toHaveLength(1);
    expect(provisionCalls[0]?.email).toBe("slack-u9@acme.localhost");
    expect(result.ok).toBe(true);
  });

  test("declines without provisioning when the wrapper's own tenant lookup comes up empty", async () => {
    nextResolution = {
      ok: false,
      reason: "no_account",
      tenantId: "tenant_1",
      email: "person@example.com",
    };
    tenantLookupResult = undefined;

    const resolve = await resolver();
    const result = await resolve({
      userId: "U1",
      email: "person@example.com",
      emailVerified: true,
      isRestricted: false,
      isBot: false,
    });

    expect(provisionCalls).toHaveLength(0);
    expect(result).toEqual(nextResolution);
  });

  test("falls back to the original resolution when provisioning itself fails", async () => {
    nextResolution = {
      ok: false,
      reason: "no_account",
      tenantId: "tenant_1",
      email: "person@example.com",
    };
    provisionShouldThrow = true;

    const resolve = await resolver();
    const result = await resolve({
      userId: "U1",
      email: "person@example.com",
      emailVerified: true,
      isRestricted: false,
      isBot: false,
    });

    expect(provisionCalls).toHaveLength(1);
    expect(result).toEqual(nextResolution);
  });
});
