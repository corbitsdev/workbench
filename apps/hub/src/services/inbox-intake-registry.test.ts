import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HubDb } from "../db";

// CL-3577 per-source poller framework. Credential resolution, the capability
// grant, member preferences, and the mailbox write are mocked at their module
// boundaries (each has its own tests); this exercises the registry dispatch:
// member vs workspace scope, the owner-enablement gate, the delivery
// primitive, and the fetcher override.

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

// A non-OAuth catalog source (granola) enabled by the member, so member-scope
// tests are not gated by the OAuth capability opt-in.
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences: async () => ({ "inboxSource:granola": true }),
  mergeMemberPreferences: async () => ({}),
}));

const { createInboxIntake } = await import("./inbox-intake");
import {
  defineFetchInboxSource,
  INBOX_SOURCE_REGISTRY,
  type InboxIntakeMember,
  type InboxSourceContext,
  type InboxSourceRegistryEntry,
} from "./inbox-source-registry";

const member: InboxIntakeMember = {
  tenantId: "ten-1",
  memberPrincipalId: "prn-1",
  inboxAddress: "usr_1@intake.test",
  tenantDomain: "intake.test",
  email: "member@intake.test",
};

function baseDeps() {
  return {
    db: {} as HubDb,
    grantStore: {} as never,
    listMembers: async () => [member],
    isTenantEnabled: async () => true,
  };
}

beforeEach(() => {
  writes.length = 0;
});

describe("INBOX_SOURCE_REGISTRY", () => {
  test("wires linear as a member-scope source", () => {
    const linear = INBOX_SOURCE_REGISTRY.find((e) => e.key === "linear");
    expect(linear?.scope).toBe("member");
  });
});

describe("member-scope dispatch", () => {
  test("invokes the handler with a member context and delivers items", async () => {
    const recorded: InboxSourceContext[] = [];
    const enqueued: string[] = [];
    const source: InboxSourceRegistryEntry = {
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
    const intake = createInboxIntake({
      ...baseDeps(),
      mailboxTriage: { enqueue: (e) => enqueued.push(e.rowId) },
      registry: [source],
    });

    await intake.tick();

    expect(recorded.length).toBe(1);
    const ctx = recorded[0]!;
    expect(ctx.scope).toBe("member");
    expect(ctx.tenantId).toBe(member.tenantId);
    expect(ctx.credential.apiKey).toBe("mtok");
    if (ctx.scope === "member") {
      expect(ctx.member.memberPrincipalId).toBe(member.memberPrincipalId);
    }
    expect(writes.map((w) => w.messageKey)).toEqual(["inbox:granola:g1"]);
    expect(enqueued).toEqual(["row-inbox:granola:g1"]);
  });

  test("a member-scope key with no registry entry is skipped, not stubbed", async () => {
    const intake = createInboxIntake({ ...baseDeps(), registry: [] });
    await intake.tick();
    expect(writes.length).toBe(0);
  });

  test("a fetch-shaped source receives the member email as the scoping arg", async () => {
    let receivedEmail: string | null | undefined = "unset";
    const source = defineFetchInboxSource("granola", async () => []);
    const intake = createInboxIntake({
      ...baseDeps(),
      mailboxTriage: { enqueue: () => {} },
      registry: [source],
      fetchers: {
        granola: async (_c, _cut, _lim, _sig, memberEmail) => {
          receivedEmail = memberEmail;
          return [];
        },
      },
    });

    await intake.tick();

    expect(receivedEmail).toBe("member@intake.test");
  });

  test("a fetch-shaped source narrows to the lastPollAt cursor on the second tick", async () => {
    const cutoffs: Date[] = [];
    const source = defineFetchInboxSource("granola", async () => []);
    const intake = createInboxIntake({
      ...baseDeps(),
      mailboxTriage: { enqueue: () => {} },
      registry: [source],
      fetchers: {
        granola: async (_c, cutoff) => {
          cutoffs.push(cutoff);
          return [];
        },
      },
    });

    await intake.tick();
    await intake.tick();

    expect(cutoffs.length).toBe(2);
    // First tick: the wide lookback cutoff. Second: the first tick's poll
    // time, which is strictly newer than the 24h lookback floor.
    expect(cutoffs[1]!.getTime()).toBeGreaterThan(cutoffs[0]!.getTime());
  });

  test("a full, limit-capped page does NOT advance the cursor (next tick re-fetches the same window)", async () => {
    const cutoffs: Date[] = [];
    const source = defineFetchInboxSource("granola", async () => []);
    const intake = createInboxIntake({
      ...baseDeps(),
      mailboxTriage: { enqueue: () => {} },
      registry: [source],
      perSourceLimit: 1,
      fetchers: {
        // Always returns a full page (length === perSourceLimit) — every
        // tick's `since` should stay pinned at the same cutoff rather than
        // advancing to wall-clock now(), which would drop unseen items past
        // the page boundary.
        granola: async (_c, cutoff) => {
          cutoffs.push(cutoff);
          return [{ externalId: "g1", subject: "s", body: "b", url: "u" }];
        },
      },
    });

    await intake.tick();
    await intake.tick();

    expect(cutoffs.length).toBe(2);
    expect(cutoffs[1]!.getTime()).toBe(cutoffs[0]!.getTime());
  });

  test("a partial page advances the cursor to the tick's start time", async () => {
    const cutoffs: Date[] = [];
    const source = defineFetchInboxSource("granola", async () => []);
    const intake = createInboxIntake({
      ...baseDeps(),
      mailboxTriage: { enqueue: () => {} },
      registry: [source],
      perSourceLimit: 5,
      fetchers: {
        // One item, well under the limit — a partial page is authoritative
        // for the window, so the cursor should advance.
        granola: async (_c, cutoff) => {
          cutoffs.push(cutoff);
          return [{ externalId: "g1", subject: "s", body: "b", url: "u" }];
        },
      },
    });

    await intake.tick();
    await intake.tick();

    expect(cutoffs.length).toBe(2);
    expect(cutoffs[1]!.getTime()).toBeGreaterThan(cutoffs[0]!.getTime());
  });

  test("a fetch-shaped source uses the injected fetcher override", async () => {
    const source = defineFetchInboxSource("granola", async () => {
      throw new Error("built-in fetcher used instead of override");
    });
    const intake = createInboxIntake({
      ...baseDeps(),
      mailboxTriage: { enqueue: () => {} },
      registry: [source],
      fetchers: {
        granola: async () => [
          { externalId: "g9", subject: "s", body: "b", url: "u" },
        ],
      },
    });

    await intake.tick();

    expect(writes.map((w) => w.messageKey)).toEqual(["inbox:granola:g9"]);
  });
});

describe("workspace-scope dispatch", () => {
  function recordingWorkspaceSource(recorded: InboxSourceContext[]) {
    return {
      key: "granola-workspace",
      scope: "workspace" as const,
      handle: async (ctx: InboxSourceContext): Promise<undefined> => {
        recorded.push(ctx);
        return undefined;
      },
    };
  }

  test("runs once per tenant when owner-enabled, ignoring member prefs", async () => {
    const recorded: InboxSourceContext[] = [];
    const members = [member, { ...member, memberPrincipalId: "prn-2" }];
    const intake = createInboxIntake({
      ...baseDeps(),
      listMembers: async () => members,
      isWorkspaceSourceEnabled: async () => true,
      registry: [recordingWorkspaceSource(recorded)],
    });

    await intake.tick();

    expect(recorded.length).toBe(1); // once per tenant, not once per member
    const ctx = recorded[0]!;
    expect(ctx.scope).toBe("workspace");
    expect(ctx.tenantId).toBe(member.tenantId);
    expect(ctx.credential.apiKey).toBe("ttok");
    expect((ctx as { member?: unknown }).member).toBeUndefined();
  });

  test("is skipped by default (owner enablement omitted → OFF)", async () => {
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      registry: [recordingWorkspaceSource(recorded)],
    });

    await intake.tick();

    expect(recorded.length).toBe(0);
  });

  test("is skipped when the tenant feature is disabled, even if owner-enabled", async () => {
    const recorded: InboxSourceContext[] = [];
    const intake = createInboxIntake({
      ...baseDeps(),
      isTenantEnabled: async () => false,
      isWorkspaceSourceEnabled: async () => true,
      registry: [recordingWorkspaceSource(recorded)],
    });

    await intake.tick();

    expect(recorded.length).toBe(0);
  });
});
