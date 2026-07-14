import { describe, expect, it, mock } from "bun:test";
import { deriveUserMailAddress } from "@workbench/hub-agent";
import type { HubDb } from "../db";

let preferences: Record<string, unknown> = {};
const mergeCalls: Record<string, unknown>[] = [];
mock.module("./member-preferences", () => ({
  readMemberPreferences: async () => preferences,
  mergeMemberPreferences: async (
    _db: unknown,
    _tenantId: string,
    _memberPrincipalId: string,
    patch: Record<string, unknown>,
  ) => {
    mergeCalls.push(patch);
    preferences = { ...preferences, ...patch };
    return preferences;
  },
}));

const { deliverWelcomeMail, WELCOME_SENT_PREFERENCE_KEY } = await import(
  "./deliver-welcome-mail"
);

const TENANT_ROW = { id: "ten-1", domain: "tenant.example" };
const MEMBER_PRINCIPAL = {
  id: "prn-member",
  tenantId: "ten-1",
  refId: "member-1",
  kind: "user",
};
const MYRA_INSTANCE = {
  id: "instance-myra-1",
  address: "instance-myra-1@tenant.example",
};

function makeDb(opts: {
  tenant?: typeof TENANT_ROW | undefined;
  principal?: typeof MEMBER_PRINCIPAL | undefined;
  agentInstance?: typeof MYRA_INSTANCE | undefined;
  user?: { id: string; name: string } | undefined;
}) {
  const inserted: Record<string, unknown>[] = [];
  const returning = mock(async () => [{ id: "row-1" }]);
  const onConflictDoNothing = mock(() => ({ returning }));
  const values = mock((row: Record<string, unknown>) => {
    inserted.push(row);
    return { onConflictDoNothing };
  });
  const db = {
    insert: mock(() => ({ values })),
    query: {
      tenant: { findFirst: mock(async () => opts.tenant) },
      principal: { findFirst: mock(async () => opts.principal) },
      agentInstance: { findFirst: mock(async () => opts.agentInstance) },
      user: { findFirst: mock(async () => opts.user) },
    },
  } as unknown as HubDb;
  return { db, inserted };
}

describe("deliverWelcomeMail", () => {
  it("writes exactly one mailbox row addressed to the member, from their Myra instance", async () => {
    preferences = {};
    mergeCalls.length = 0;
    const { db, inserted } = makeDb({
      tenant: TENANT_ROW,
      principal: MEMBER_PRINCIPAL,
      agentInstance: MYRA_INSTANCE,
      user: { id: "member-1", name: "Alice" },
    });

    await deliverWelcomeMail({
      db,
      tenantId: "ten-1",
      memberPrincipalId: "prn-member",
      myraInstanceId: "instance-myra-1",
    });

    expect(inserted).toHaveLength(1);
    const row = inserted[0] as Record<string, unknown>;
    expect(row.principalId).toBe("prn-member");
    expect(row.address).toBe(
      deriveUserMailAddress({
        userRefId: "member-1",
        domain: "tenant.example",
      }),
    );
    expect(row.fromAddress).toBe(MYRA_INSTANCE.address);
    expect(row.messageKey).toBe("welcome:prn-member");
    const raw = new TextDecoder().decode(row.raw as Uint8Array);
    expect(raw).toContain("Hi Alice,");

    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]?.[WELCOME_SENT_PREFERENCE_KEY]).toBeDefined();
  });

  it("is idempotent: a second call with the stamp already set writes nothing", async () => {
    preferences = { [WELCOME_SENT_PREFERENCE_KEY]: "2026-07-01T00:00:00.000Z" };
    mergeCalls.length = 0;
    const { db, inserted } = makeDb({
      tenant: TENANT_ROW,
      principal: MEMBER_PRINCIPAL,
      agentInstance: MYRA_INSTANCE,
      user: { id: "member-1", name: "Alice" },
    });

    await deliverWelcomeMail({
      db,
      tenantId: "ten-1",
      memberPrincipalId: "prn-member",
      myraInstanceId: "instance-myra-1",
    });

    expect(inserted).toHaveLength(0);
    expect(mergeCalls).toHaveLength(0);
  });

  it("does not stamp the preference when the mailbox write is deduped (no row returned)", async () => {
    preferences = {};
    mergeCalls.length = 0;
    const returning = mock(async () => []);
    const onConflictDoNothing = mock(() => ({ returning }));
    const inserted: Record<string, unknown>[] = [];
    const values = mock((row: Record<string, unknown>) => {
      inserted.push(row);
      return { onConflictDoNothing };
    });
    const db = {
      insert: mock(() => ({ values })),
      query: {
        tenant: { findFirst: mock(async () => TENANT_ROW) },
        principal: { findFirst: mock(async () => MEMBER_PRINCIPAL) },
        agentInstance: { findFirst: mock(async () => MYRA_INSTANCE) },
        user: {
          findFirst: mock(async () => ({ id: "member-1", name: "Alice" })),
        },
      },
    } as unknown as HubDb;

    await deliverWelcomeMail({
      db,
      tenantId: "ten-1",
      memberPrincipalId: "prn-member",
      myraInstanceId: "instance-myra-1",
    });

    expect(inserted).toHaveLength(1);
    expect(mergeCalls).toHaveLength(0);
  });

  it("never throws when the tenant lookup fails", async () => {
    preferences = {};
    const db = {
      query: {
        tenant: { findFirst: mock(() => Promise.reject(new Error("db down"))) },
      },
    } as unknown as HubDb;

    await expect(
      deliverWelcomeMail({
        db,
        tenantId: "ten-1",
        memberPrincipalId: "prn-member",
        myraInstanceId: "instance-myra-1",
      }),
    ).resolves.toBeUndefined();
  });

  it("skips without writing when the Myra instance row is missing", async () => {
    preferences = {};
    mergeCalls.length = 0;
    const { db, inserted } = makeDb({
      tenant: TENANT_ROW,
      principal: MEMBER_PRINCIPAL,
      agentInstance: undefined,
      user: { id: "member-1", name: "Alice" },
    });

    await deliverWelcomeMail({
      db,
      tenantId: "ten-1",
      memberPrincipalId: "prn-member",
      myraInstanceId: "instance-myra-1",
    });

    expect(inserted).toHaveLength(0);
  });
});
