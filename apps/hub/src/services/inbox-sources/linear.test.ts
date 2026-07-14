import { describe, expect, mock, test } from "bun:test";
import type { MemberToolCredential } from "../../lib/member-tool-credential";

// True module-boundary mock: @workbench/tools-linear owns the actual HTTP
// call. Each test controls the GraphQL response shape returned per query.
let respond: (
  query: string,
  variables: Record<string, unknown>,
) => unknown = () => ({});
const calls: { query: string; variables: Record<string, unknown> }[] = [];

mock.module("@workbench/tools-linear", () => ({
  fetchLinearGraphQL: async (
    _config: unknown,
    query: string,
    variables: Record<string, unknown>,
  ) => {
    calls.push({ query, variables });
    return respond(query, variables);
  },
}));

const { fetchLinearInboxItems } = await import("./linear");

const MEMBER_CRED: MemberToolCredential = {
  apiKey: "member-oauth-token",
  baseURL: "",
  source: "member",
};

const TENANT_CRED: MemberToolCredential = {
  apiKey: "tenant-api-key",
  baseURL: "",
  source: "tenant",
};

function emptyResponses() {
  respond = (query) => {
    if (query.includes("InboxIntakeNotifications")) {
      return { viewer: { notifications: { nodes: [] } } };
    }
    if (query.includes("InboxIntakeAssignedIssues")) {
      return { viewer: { assignedIssues: { nodes: [] } } };
    }
    return { viewer: { assignedIssuesComments: { nodes: [] } } };
  };
}

const CUTOFF = new Date("2026-07-12T00:00:00.000Z");
const NOW = new Date("2026-07-13T00:00:00.000Z");

test("tenant-key credential skips the viewer-scoped sync entirely (no member identity)", async () => {
  calls.length = 0;
  const items = await fetchLinearInboxItems(
    TENANT_CRED,
    CUTOFF,
    25,
    new AbortController().signal,
  );
  expect(items).toEqual([]);
  expect(calls.length).toBe(0);
});

describe("member OAuth credential", () => {
  test("merges notifications, assigned issues, and comments into one batch", async () => {
    respond = (query) => {
      if (query.includes("InboxIntakeNotifications")) {
        return {
          viewer: {
            notifications: {
              nodes: [
                {
                  id: "notif-1",
                  createdAt: "2026-07-12T10:00:00.000Z",
                  type: "issueAssignedToYou",
                  issue: {
                    id: "iss-1",
                    identifier: "ENG-1",
                    title: "Fix the thing",
                    url: "https://linear.app/x/issue/ENG-1",
                  },
                },
              ],
            },
          },
        };
      }
      if (query.includes("InboxIntakeAssignedIssues")) {
        return {
          viewer: {
            assignedIssues: {
              nodes: [
                {
                  id: "iss-2",
                  identifier: "ENG-2",
                  title: "New assigned issue",
                  url: "https://linear.app/x/issue/ENG-2",
                  createdAt: "2026-07-12T11:00:00.000Z",
                  updatedAt: "2026-07-12T11:00:00.000Z",
                  state: { name: "Todo" },
                },
              ],
            },
          },
        };
      }
      return {
        viewer: {
          assignedIssuesComments: {
            nodes: [
              {
                id: "cmt-1",
                createdAt: "2026-07-12T12:00:00.000Z",
                body: "Looks good to me",
                issue: {
                  id: "iss-3",
                  identifier: "ENG-3",
                  title: "Older issue",
                  url: "https://linear.app/x/issue/ENG-3",
                },
              },
            ],
          },
        },
      };
    };

    const items = await fetchLinearInboxItems(
      MEMBER_CRED,
      CUTOFF,
      25,
      new AbortController().signal,
    );

    const ids = items.map((i) => i.externalId).sort();
    expect(ids).toEqual([
      "comment:cmt-1",
      "issue:iss-2:created:1783854000",
      "notification:notif-1",
    ]);
  });

  test("returns [] and does not throw on a malformed response shape", async () => {
    respond = () => ({ viewer: { notifications: { nodes: "not-an-array" } } });
    const items = await fetchLinearInboxItems(
      MEMBER_CRED,
      CUTOFF,
      25,
      new AbortController().signal,
    );
    expect(items).toEqual([]);
  });
});

describe("dedupe design: externalId stability across ticks", () => {
  test("an unchanged assigned issue re-fetched in a later, overlapping tick produces the SAME externalId", async () => {
    emptyResponses();
    const unchangedIssue = {
      id: "iss-5",
      identifier: "ENG-5",
      title: "Stable issue",
      url: "https://linear.app/x/issue/ENG-5",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T09:00:00.000Z",
      state: { name: "In Progress" },
    };
    const withIssue = () => ({
      viewer: { assignedIssues: { nodes: [unchangedIssue] } },
    });

    respond = (query) => {
      if (query.includes("InboxIntakeAssignedIssues")) return withIssue();
      if (query.includes("InboxIntakeNotifications")) {
        return { viewer: { notifications: { nodes: [] } } };
      }
      return { viewer: { assignedIssuesComments: { nodes: [] } } };
    };

    const firstTick = await fetchLinearInboxItems(
      MEMBER_CRED,
      CUTOFF,
      25,
      new AbortController().signal,
    );
    const secondTick = await fetchLinearInboxItems(
      MEMBER_CRED,
      NOW, // a later tick's cutoff moved forward, but Linear still returns the
      // same unchanged row inside a stale/overlapping filter window
      25,
      new AbortController().signal,
    );

    const firstIssueItem = firstTick.find((i) =>
      i.externalId.startsWith("issue:iss-5"),
    );
    const secondIssueItem = secondTick.find((i) =>
      i.externalId.startsWith("issue:iss-5"),
    );
    expect(firstIssueItem?.externalId).toBe(secondIssueItem?.externalId);
  });

  test("a genuine update to updatedAt produces a NEW externalId for the same issue", async () => {
    emptyResponses();
    const baseIssue = {
      id: "iss-6",
      identifier: "ENG-6",
      title: "Issue that changes",
      url: "https://linear.app/x/issue/ENG-6",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-11T09:00:00.000Z",
      state: { name: "Todo" },
    };

    respond = (query) => {
      if (query.includes("InboxIntakeAssignedIssues")) {
        return { viewer: { assignedIssues: { nodes: [baseIssue] } } };
      }
      if (query.includes("InboxIntakeNotifications")) {
        return { viewer: { notifications: { nodes: [] } } };
      }
      return { viewer: { assignedIssuesComments: { nodes: [] } } };
    };
    const before = await fetchLinearInboxItems(
      MEMBER_CRED,
      CUTOFF,
      25,
      new AbortController().signal,
    );

    respond = (query) => {
      if (query.includes("InboxIntakeAssignedIssues")) {
        return {
          viewer: {
            assignedIssues: {
              nodes: [{ ...baseIssue, updatedAt: "2026-07-12T15:30:00.000Z" }],
            },
          },
        };
      }
      if (query.includes("InboxIntakeNotifications")) {
        return { viewer: { notifications: { nodes: [] } } };
      }
      return { viewer: { assignedIssuesComments: { nodes: [] } } };
    };
    const after = await fetchLinearInboxItems(
      MEMBER_CRED,
      CUTOFF,
      25,
      new AbortController().signal,
    );

    expect(before[0]?.externalId).not.toBe(after[0]?.externalId);
  });
});
