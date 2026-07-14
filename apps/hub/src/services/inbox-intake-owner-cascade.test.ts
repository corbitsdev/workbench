import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HubDb } from "../db";

// CL-3584: the owner-level enablement is the tenant ceiling above a member's
// `inboxSource:*` preference. An owner-disabled member-scope source is skipped
// for every member REGARDLESS of their preference; member preferences are never
// consulted for deletion, so re-enabling restores the prior choice. The
// credential rail, capability grant, and mailbox write are mocked at their
// module boundaries (each has its own tests).

const writes: { messageKey: string }[] = [];
mock.module("../lib/mailbox-write", () => ({
  writeMailboxMessage: async (_db: unknown, args: { messageKey: string }) => {
    writes.push(args);
    return { id: `row-${args.messageKey}` };
  },
  buildMailFrame: () => new Uint8Array(),
}));

mock.module("../lib/member-tool-credential", () => ({
  resolveMemberOrTenantToolCredential: async () => ({
    apiKey: "mtok",
    baseURL: "",
    source: "member" as const,
  }),
  resolveTenantToolCredential: async () => ({
    apiKey: "ttok",
    baseURL: "",
    source: "tenant" as const,
  }),
}));

mock.module("../lib/capability-grants", () => ({
  isMemberSelfServiceCapabilityActive: async () => true,
}));

// The member has opted into granola: their preference enables it.
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async () => ({ "inboxSource:granola": true }),
  mergeMemberPreferences: async () => ({}),
}));

const { createInboxIntake } = await import("./inbox-intake");
import type {
  InboxIntakeMember,
  InboxSourceContext,
  InboxSourceRegistryEntry,
} from "./inbox-source-registry";

const member: InboxIntakeMember = {
  tenantId: "ten-1",
  memberPrincipalId: "prn-1",
  inboxAddress: "usr_1@intake.test",
  tenantDomain: "intake.test",
  email: "member@intake.test",
};

function granolaSource(
  recorded: InboxSourceContext[],
): InboxSourceRegistryEntry {
  return {
    key: "granola",
    scope: "member",
    handle: async (ctx) => {
      recorded.push(ctx);
      if (ctx.scope === "member") {
        await ctx.deliverItems([
          { externalId: "g1", subject: "S", body: "B", url: "u" },
        ]);
      }
    },
  };
}

function baseDeps() {
  return {
    db: {} as HubDb,
    grantStore: {} as never,
    listMembers: async () => [member],
    isTenantEnabled: async () => true,
    mailboxTriage: { enqueue: () => {} },
  };
}

beforeEach(() => {
  writes.length = 0;
});

describe("member-scope owner cascade", () => {
  test("skips an owner-disabled source even though the member enabled it", async () => {
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      registry: [granolaSource(recorded)],
      isMemberSourceEnabled: async () => false,
    });

    await intake.tick();

    expect(recorded.length).toBe(0);
    expect(writes.length).toBe(0);
  });

  test("runs the source once the owner enables it (member pref honored)", async () => {
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      registry: [granolaSource(recorded)],
      isMemberSourceEnabled: async () => true,
    });

    await intake.tick();

    expect(recorded.length).toBe(1);
    expect(writes.map((w) => w.messageKey)).toEqual(["inbox:granola:g1"]);
  });

  test("gate is consulted per source key with the member's tenant", async () => {
    const seen: { tenantId: string; sourceKey: string }[] = [];
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      registry: [granolaSource(recorded)],
      isMemberSourceEnabled: async (tenantId, sourceKey) => {
        seen.push({ tenantId, sourceKey });
        return true;
      },
    });

    await intake.tick();

    expect(seen).toEqual([{ tenantId: "ten-1", sourceKey: "granola" }]);
  });

  test("a gate failure is treated as disabled, never fails open", async () => {
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      registry: [granolaSource(recorded)],
      isMemberSourceEnabled: async () => {
        throw new Error("grant store down");
      },
    });

    await intake.tick();

    expect(recorded.length).toBe(0);
    expect(writes.length).toBe(0);
  });

  test("defaults to enabled when the gate is not wired (backward compat)", async () => {
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      registry: [granolaSource(recorded)],
    });

    await intake.tick();

    expect(recorded.length).toBe(1);
  });
});
