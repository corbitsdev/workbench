import { describe, expect, test } from "bun:test";
import {
  buildDailyLinkedInBatch,
  enrichDailyLinkedInTriggerPayload,
  DAILY_LINKEDIN_FROM_LOCAL,
  dailyDraftSourceRef,
  dailyMailMessageKey,
  LINKEDIN_DAILY_DRAFT_KIND,
  mailboxAddressForMember,
  STORY_BUCKET_ARTIFACT_KIND,
  utcDayString,
} from "./index";

describe("dailyDraftSourceRef", () => {
  test("keys on the recipient refId, not a tenant principal id", () => {
    expect(dailyDraftSourceRef("alex", "2026-07-24")).toBe(
      "linkedin-daily:alex:2026-07-24",
    );
  });

  test("rejects empty refId or bad day", () => {
    expect(() => dailyDraftSourceRef("", "2026-07-24")).toThrow(/refId/);
    expect(() => dailyDraftSourceRef("alex", "7/24/2026")).toThrow(
      /YYYY-MM-DD/,
    );
  });
});

describe("dailyMailMessageKey", () => {
  test("keys on the recipient refId for mailbox dedupe", () => {
    expect(dailyMailMessageKey("alex", "2026-07-24")).toBe(
      "linkedin-daily-mail:alex:2026-07-24",
    );
  });
});

describe("mailboxAddressForMember", () => {
  test("swaps owner ref for member ref on same domain", () => {
    expect(
      mailboxAddressForMember("usr_owner123@workbench.example", "member456"),
    ).toBe("usr_member456@workbench.example");
  });

  test("strips an existing usr_ prefix on member refId", () => {
    expect(mailboxAddressForMember("usr_a@tenant.dev", "usr_b")).toBe(
      "usr_b@tenant.dev",
    );
  });

  test("rejects malformed owner address", () => {
    expect(() => mailboxAddressForMember("not-an-email", "x")).toThrow(
      /ownerUserAddress/,
    );
  });
});

describe("buildDailyLinkedInBatch", () => {
  test("builds inbox_deliver_batch-shaped payload with stable keys", () => {
    const batch = buildDailyLinkedInBatch({
      userAddress: "usr_owner@workbench.example",
      dayUtc: "2026-07-24",
      drafts: [{ displayName: "Alex", refId: "alex", body: "Post body" }],
    });
    expect(batch.fromLocalPart).toBe(DAILY_LINKEDIN_FROM_LOCAL);
    expect(batch.userAddress).toBe("usr_owner@workbench.example");
    expect(batch.deliveries).toHaveLength(1);
    const d = batch.deliveries[0]!;
    expect(d.refId).toBe("alex");
    expect(d.messageKey).toBe(dailyMailMessageKey("alex", "2026-07-24"));
    expect(d.artifact.sourceRef).toBe(
      dailyDraftSourceRef("alex", "2026-07-24"),
    );
    expect(d.artifact.kind).toBe(LINKEDIN_DAILY_DRAFT_KIND);
    expect(d.subject).toContain("Alex");
    expect(d.body).toBe("Post body");
    // No tenant principal id may appear anywhere in a pack-built payload.
    expect(JSON.stringify(batch)).not.toContain("pri_");
  });

  test("a same-day re-run reuses both idempotency keys verbatim", () => {
    const args = {
      userAddress: "usr_owner@workbench.example",
      dayUtc: "2026-07-24",
      drafts: [{ refId: "alex", displayName: "Alex", body: "Post body" }],
    };
    expect(buildDailyLinkedInBatch(args)).toEqual(
      buildDailyLinkedInBatch(args),
    );
  });
});

describe("constants + utcDayString", () => {
  test("stable artifact kinds", () => {
    expect(STORY_BUCKET_ARTIFACT_KIND).toBe("story-bucket");
    expect(LINKEDIN_DAILY_DRAFT_KIND).toBe("linkedin-daily-draft");
  });

  test("utcDayString is YYYY-MM-DD", () => {
    expect(utcDayString(new Date("2026-07-24T15:00:00.000Z"))).toBe(
      "2026-07-24",
    );
  });
});

describe("enrichDailyLinkedInTriggerPayload", () => {
  const ALEX = { refId: "u_alex", displayName: "Alex" };

  test("stamps the firing member's identity onto the schedule payload", () => {
    expect(
      enrichDailyLinkedInTriggerPayload(
        { recipients: [ALEX] },
        {
          userAddress: "usr_owner@workbench.example",
          userRefId: "owner",
          userDisplayName: "Owner",
        },
      ),
    ).toEqual({
      recipients: [ALEX],
      userAddress: "usr_owner@workbench.example",
      userRefId: "owner",
      userDisplayName: "Owner",
    });
  });

  // An agent principal (or an identity-lookup miss) has no display name. The
  // key must be OMITTED, not set to undefined — the drafting prompt only frames
  // voice with it, and a present-but-undefined key reads as a real value to a
  // JSON-serialized payload consumer.
  test("omits userDisplayName entirely when the member has none", () => {
    const enriched = enrichDailyLinkedInTriggerPayload(
      { recipients: [ALEX] },
      { userAddress: "usr_o@x.dev", userRefId: "o" },
    );
    expect(Object.keys(enriched).sort()).toEqual([
      "recipients",
      "userAddress",
      "userRefId",
    ]);
  });

  test("identity overrides any address a stored schedule payload carried", () => {
    const enriched = enrichDailyLinkedInTriggerPayload(
      { recipients: [ALEX], userAddress: "usr_stale@old.dev" },
      { userAddress: "usr_o@x.dev", userRefId: "o" },
    );
    expect(enriched.userAddress).toBe("usr_o@x.dev");
  });

  test("fails loudly on a blank identity rather than delivering nowhere", () => {
    expect(() =>
      enrichDailyLinkedInTriggerPayload(
        { recipients: [ALEX] },
        { userAddress: "", userRefId: "o" },
      ),
    ).toThrow(/userAddress/);
    expect(() =>
      enrichDailyLinkedInTriggerPayload(
        { recipients: [ALEX] },
        { userAddress: "usr_o@x.dev", userRefId: "  " },
      ),
    ).toThrow(/userRefId/);
  });
});

// A schedule row is long-lived. One stored against the OLD select-multi shape
// held a bare `string[]` of `prn_` principal ids; those are not refIds, so every
// recipient would resolve to nobody, be skipped, and the run would claim success
// having delivered nothing. Fail at the boundary instead.
describe("enrichDailyLinkedInTriggerPayload recipient parsing", () => {
  const IDENTITY = { userAddress: "usr_o@x.dev", userRefId: "o" };

  test("rejects a stale schedule that stored bare principal-id strings", () => {
    expect(() =>
      enrichDailyLinkedInTriggerPayload(
        { recipients: ["prn_a", "prn_b"] },
        IDENTITY,
      ),
    ).toThrow(/not a list of \{ refId, displayName \} people/);
  });

  test("rejects a recipient missing its routing key", () => {
    expect(() =>
      enrichDailyLinkedInTriggerPayload(
        { recipients: [{ displayName: "Alex" }] },
        IDENTITY,
      ),
    ).toThrow(/refId/);
  });

  test("rejects a recipient whose refId is blank", () => {
    expect(() =>
      enrichDailyLinkedInTriggerPayload(
        { recipients: [{ refId: "", displayName: "Alex" }] },
        IDENTITY,
      ),
    ).toThrow(/refId/);
  });

  test("rejects an empty selection — empty means nobody, never everyone", () => {
    expect(() =>
      enrichDailyLinkedInTriggerPayload({ recipients: [] }, IDENTITY),
    ).toThrow(/no recipients/);
  });

  test("rejects a schedule with no recipients field at all", () => {
    expect(() => enrichDailyLinkedInTriggerPayload({}, IDENTITY)).toThrow(
      /not a list of/,
    );
  });

  test("accepts a blank displayName — only refId is load-bearing", () => {
    const enriched = enrichDailyLinkedInTriggerPayload(
      { recipients: [{ refId: "u_alex", displayName: "" }] },
      IDENTITY,
    );
    expect(enriched.recipients).toEqual([{ refId: "u_alex", displayName: "" }]);
  });
});
