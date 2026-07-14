import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";

// CL-3511 end-to-end: an enabled inbox source + a usable credential lands one
// mailbox row per new item, deduped by messageKey, pushed via the event bus,
// and handed to triage. Credential resolution + the capability grant are mocked
// at their module boundaries (each has its own tests); the write path,
// dedupe, SSE publish, and triage handoff are exercised against real Postgres.

mock.module("../lib/member-tool-credential", () => ({
  resolveMemberOrTenantToolCredential: async () => ({
    apiKey: "tok",
    baseURL: "",
    source: "tenant" as const,
  }),
  resolveTenantToolCredential: async () => ({
    apiKey: "tok",
    baseURL: "",
    source: "tenant" as const,
  }),
}));

mock.module("../lib/capability-grants", () => ({
  isMemberSelfServiceCapabilityActive: async () => true,
}));

// Inbox sources default OFF (CL-3577); the member has explicitly enabled the
// linear source so the tick has something to poll. Tests that exercise the
// Linear backfill marker (CL-3577) override `readMemberPreferences` per test
// via `mockImplementationOnce`; `mergeMemberPreferences` is a plain mock so
// its calls can be asserted without touching real storage.
const readMemberPreferences = mock(async () => ({
  "inboxSource:linear": true,
}));
const mergeMemberPreferences = mock(
  async (
    _db: unknown,
    _tenantId: string,
    _memberPrincipalId: string,
    _patch: Record<string, unknown>,
  ) => ({}),
);
mock.module("../lib/member-preferences", () => ({
  readMemberPreferences,
  mergeMemberPreferences,
}));

const { createInboxIntake } = await import("./inbox-intake");
import { schema } from "../db";
import type { HubDb } from "../db";
import type { IntakeItem, InboxSourceFetcher } from "./inbox-intake";

const TENANT = "ten-intake";
const MEMBER = "prn-member";
const DOMAIN = "intake.test";
const INBOX = `usr_member@${DOMAIN}`;

let client: PGlite;
let db: HubDb;

const member = {
  tenantId: TENANT,
  memberPrincipalId: MEMBER,
  inboxAddress: INBOX,
  tenantDomain: DOMAIN,
  email: "member@intake.test",
};

function fetcherReturning(
  items: IntakeItem[],
): Record<string, InboxSourceFetcher> {
  return { linear: async () => items };
}

async function mailboxRows() {
  return client.query<{ message_key: string; subject: string }>(
    `select message_key, subject from principal_mailbox where principal_id = $1 order by created_at`,
    [MEMBER],
  );
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM principal_mailbox;`);
});

afterEach(() => {
  readMemberPreferences.mockClear();
  mergeMemberPreferences.mockClear();
});

describe("inbox intake tick", () => {
  test("an enabled source with a credential lands a row and pushes via SSE + triage", async () => {
    const published: string[] = [];
    const enqueued: string[] = [];
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => true,
      mailboxEventBus: {
        publish: (principalId: string) => published.push(principalId),
      } as never,
      mailboxTriage: {
        enqueue: (event) => enqueued.push(event.subject ?? ""),
      },
      fetchers: fetcherReturning([
        {
          externalId: "iss-1",
          subject: "[ENG-1] Fix the thing",
          body: "New Linear issue ENG-1\nLink: https://linear.app/x/ENG-1",
          url: "https://linear.app/x/ENG-1",
        },
      ]),
    });

    await intake.tick();

    const rows = (await mailboxRows()).rows;
    expect(rows.map((r) => r.message_key)).toEqual(["inbox:linear:iss-1"]);
    expect(rows[0]?.subject).toBe("[ENG-1] Fix the thing");
    expect(published).toEqual([MEMBER]);
    expect(enqueued).toEqual(["[ENG-1] Fix the thing"]);
  });

  test("a second tick over the same item is deduped (no new row, no re-triage)", async () => {
    const enqueued: string[] = [];
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => true,
      mailboxTriage: { enqueue: (e) => enqueued.push(e.rowId) },
      fetchers: fetcherReturning([
        {
          externalId: "iss-1",
          subject: "[ENG-1] Fix the thing",
          body: "body",
          url: "https://linear.app/x/ENG-1",
        },
      ]),
    });

    await intake.tick();
    await intake.tick();

    expect((await mailboxRows()).rows.length).toBe(1);
    expect(enqueued.length).toBe(1);
  });

  test("a disabled tenant lands nothing", async () => {
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => false,
      fetchers: fetcherReturning([
        { externalId: "iss-9", subject: "x", body: "y", url: "z" },
      ]),
    });
    await intake.tick();
    expect((await mailboxRows()).rows.length).toBe(0);
  });

  test("an enabled source with no wired registry entry is skipped without error", async () => {
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => true,
      registry: [],
    });
    await intake.tick();
    expect((await mailboxRows()).rows.length).toBe(0);
  });
});

describe("Linear one-time backfill on enable (CL-3577)", () => {
  test("widens the first poll's cutoff per inboxSource:linear:backfill, then stamps the applied marker", async () => {
    readMemberPreferences.mockImplementationOnce(async () => ({
      "inboxSource:linear": true,
      "inboxSource:linear:backfill": "30d",
    }));
    const seenCutoffs: Date[] = [];
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => true,
      lookbackMs: 60_000,
      fetchers: {
        linear: async (_credential, cutoff) => {
          seenCutoffs.push(cutoff);
          return [];
        },
      },
    });

    await intake.tick();

    expect(seenCutoffs).toHaveLength(1);
    const defaultCutoff = Date.now() - 60_000;
    // A 30-day-wide cutoff is far earlier than the 60s default lookback.
    expect(seenCutoffs[0]!.getTime()).toBeLessThan(defaultCutoff - 1000);

    expect(mergeMemberPreferences).toHaveBeenCalledTimes(1);
    const call = mergeMemberPreferences.mock.calls[0]!;
    expect(call[1]).toBe(TENANT);
    expect(call[2]).toBe(MEMBER);
    expect(typeof call[3]["inboxSource:linear:backfillAppliedAt"]).toBe(
      "string",
    );
  });

  test("does not widen the cutoff once the marker is already stamped", async () => {
    readMemberPreferences.mockImplementationOnce(async () => ({
      "inboxSource:linear": true,
      "inboxSource:linear:backfill": "30d",
      "inboxSource:linear:backfillAppliedAt": "2026-01-01T00:00:00.000Z",
    }));
    const seenCutoffs: Date[] = [];
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => true,
      lookbackMs: 60_000,
      fetchers: {
        linear: async (_credential, cutoff) => {
          seenCutoffs.push(cutoff);
          return [];
        },
      },
    });

    await intake.tick();

    expect(seenCutoffs).toHaveLength(1);
    const defaultCutoff = Date.now() - 60_000;
    expect(seenCutoffs[0]!.getTime()).toBeGreaterThanOrEqual(
      defaultCutoff - 1000,
    );
    expect(mergeMemberPreferences).not.toHaveBeenCalled();
  });

  test("backfill 'none' applies no widening but still stamps the marker on first poll", async () => {
    readMemberPreferences.mockImplementationOnce(async () => ({
      "inboxSource:linear": true,
      "inboxSource:linear:backfill": "none",
    }));
    const seenCutoffs: Date[] = [];
    const intake = createInboxIntake({
      db,
      grantStore: {} as never,
      listMembers: async () => [member],
      isTenantEnabled: async () => true,
      lookbackMs: 60_000,
      fetchers: {
        linear: async (_credential, cutoff) => {
          seenCutoffs.push(cutoff);
          return [];
        },
      },
    });

    await intake.tick();

    const defaultCutoff = Date.now() - 60_000;
    expect(seenCutoffs[0]!.getTime()).toBeGreaterThanOrEqual(
      defaultCutoff - 1000,
    );
    expect(mergeMemberPreferences).toHaveBeenCalledTimes(1);
  });
});
