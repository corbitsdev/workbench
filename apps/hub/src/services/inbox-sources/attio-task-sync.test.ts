import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";

// CL-3579: the Attio task-sync member source writes real Workbench `task`
// rows (create / update / complete / delete) against real Postgres (pglite),
// with the only mock at the tools-attio module boundary — the fetcher itself
// stays real inside `createAttioTools`, so the request-shaping (query params,
// JSON body) still runs.

// tools-attio defaults to the global `fetch` when no fetcher is injected
// (`createAttioTools` only accepts one via `AttioToolsConfig.fetcher`, which
// this source does not set). The true boundary for this source is therefore
// the network call itself — mocked here by replacing `globalThis.fetch`,
// same as mocking any other external HTTP dependency.
type FetchCall = { url: string; init: RequestInit };
let calls: FetchCall[] = [];
let responder: (url: string, init: RequestInit) => Response;

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const href = url.toString();
  calls.push({ url: href, init: init ?? {} });
  return responder(href, init ?? {});
}) as typeof fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function attioTaskRow(args: {
  id: string;
  content?: string;
  isCompleted?: boolean;
  deadlineAt?: string | null;
  createdAt?: string;
  assignees?: string[];
}) {
  return {
    id: { task_id: args.id },
    content_plaintext: args.content ?? "Follow up with Acme",
    is_completed: args.isCompleted ?? false,
    deadline_at: args.deadlineAt ?? null,
    created_at: args.createdAt ?? "2026-07-10T00:00:00.000Z",
    assignees: (args.assignees ?? []).map((id) => ({
      referenced_actor_id: id,
    })),
  };
}

import { schema } from "../../db";
import type { HubDb } from "../../db";
import { task } from "../../db/schema";
import { mergeMemberPreferences } from "../../lib/member-preferences";
import type { MemberInboxSourceContext } from "../inbox-source-registry";
import { attioTaskSyncInboxSource } from "./attio-task-sync";

const TENANT = "ten-attio";
const MEMBER = "prn-attio-member";
// The member's own Attio workspace-member id (review fix C): most tests set
// this via `mergeMemberPreferences` and scope created tasks' assignees to it,
// since a member with no attioMemberId preference must never have a task
// created for them (see the dedicated "no attioMemberId" describe block).
const SELF_ATTIO_MEMBER_ID = "wm-attio-self";

let client: PGlite;
let db: HubDb;

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
  globalThis.fetch = originalFetch;
});

beforeEach(async () => {
  await client.exec(`DELETE FROM task;`);
  await client.exec(`DELETE FROM task_external_ref;`);
  await client.exec(`DELETE FROM member_preferences;`);
  calls = [];
  await mergeMemberPreferences(db, TENANT, MEMBER, {
    attioMemberId: SELF_ATTIO_MEMBER_ID,
  });
});

function baseCtx(
  overrides: Partial<MemberInboxSourceContext> = {},
): MemberInboxSourceContext {
  return {
    scope: "member",
    db,
    tenantId: TENANT,
    member: {
      tenantId: TENANT,
      memberPrincipalId: MEMBER,
      inboxAddress: `usr_member@attio.test`,
      tenantDomain: "attio.test",
      email: "member@attio.test",
    },
    credential: { apiKey: "tok", baseURL: "", source: "member" },
    cutoff: new Date("2026-07-01T00:00:00.000Z"),
    perSourceLimit: 25,
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {} } as never,
    deliverItems: async () => 0,
    memberPreferences: {},
    ...overrides,
  };
}

async function tasksForMember() {
  return db.select().from(task).where(eq(task.ownerPrincipalId, MEMBER));
}

describe("attioTaskSyncInboxSource", () => {
  test("creates a new Workbench task for a new open Attio task", async () => {
    responder = (url) => {
      if (url.includes("/v2/tasks") && !url.includes("task_")) {
        return jsonResponse(200, {
          data: [
            attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    };

    await attioTaskSyncInboxSource.handle(
      baseCtx({ credential: { apiKey: "tok", baseURL: "", source: "member" } }),
    );

    const rows = await tasksForMember();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Follow up with Acme");
    expect(rows[0]?.sourceRef).toBe("attio:task:task_1");
    expect(rows[0]?.status).toBe("open");
  });

  test("is idempotent: a second tick over the same task does not duplicate it", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });

    await attioTaskSyncInboxSource.handle(baseCtx());
    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows).toHaveLength(1);
  });

  test("updates title and due date when the Attio task changes", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({
            id: "task_1",
            content: "Original title",
            assignees: [SELF_ATTIO_MEMBER_ID],
          }),
        ],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({
            id: "task_1",
            content: "Updated title",
            deadlineAt: "2026-08-01T00:00:00.000Z",
          }),
        ],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Updated title");
    expect(rows[0]?.due?.toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });

  test("marks the Workbench task done when Attio marks it completed", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    responder = () =>
      jsonResponse(200, {
        data: [attioTaskRow({ id: "task_1", isCompleted: true })],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows[0]?.status).toBe("done");
  });

  test("skips creating a task that arrives already completed", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [attioTaskRow({ id: "task_1", isCompleted: true })],
      });

    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows).toHaveLength(0);
  });

  test("marks a previously-synced task done when Attio confirms it was deleted (404)", async () => {
    responder = (url) => {
      if (url.includes("/v2/tasks") && !url.includes("task_")) {
        return jsonResponse(200, {
          data: [
            attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
          ],
        });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    await attioTaskSyncInboxSource.handle(baseCtx());
    let rows = await tasksForMember();
    expect(rows[0]?.status).toBe("open");

    // Second tick: the task no longer appears in the list, and a direct
    // lookup confirms it is gone (404) rather than merely paginated out.
    responder = (url) => {
      if (url.endsWith("/v2/tasks?limit=25&offset=0&sort=created_at%3Adesc")) {
        return jsonResponse(200, { data: [] });
      }
      if (url.includes("/v2/tasks/task_1")) {
        return jsonResponse(404, { message: "not found" });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    await attioTaskSyncInboxSource.handle(baseCtx());

    rows = await tasksForMember();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("done");
  });

  test("leaves a previously-synced task alone when the missing-from-list check errors ambiguously", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    responder = (url) => {
      if (url.includes("/v2/tasks?")) {
        return jsonResponse(200, { data: [] });
      }
      if (url.includes("/v2/tasks/task_1")) {
        return jsonResponse(500, { message: "server error" });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("open");
  });

  test("never revives a task the member explicitly cancelled", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    const [existing] = await tasksForMember();
    if (!existing) throw new Error("expected a row");
    await db
      .update(task)
      .set({ status: "cancelled" })
      .where(eq(task.id, existing.id));

    responder = () =>
      jsonResponse(200, {
        data: [attioTaskRow({ id: "task_1", content: "Changed after cancel" })],
      });
    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("cancelled");
    expect(rows[0]?.title).not.toBe("Changed after cancel");
  });

  test("a full, limit-capped page advances nextCursor to the max processed created_at (no livelock)", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({
            id: "task_1",
            assignees: [SELF_ATTIO_MEMBER_ID],
            createdAt: "2026-07-05T00:00:00.000Z",
          }),
        ],
      });
    const since = new Date("2026-07-01T00:00:00.000Z");

    const result = await attioTaskSyncInboxSource.handle(
      baseCtx({ cutoff: since, perSourceLimit: 1 }),
    );

    // The processed task's own created_at, not the unchanged `since` floor —
    // pinning at `since` would re-issue the identical query forever under
    // sustained overflow (>= perSourceLimit new tasks every tick).
    expect(result).toEqual({
      nextCursor: new Date("2026-07-05T00:00:00.000Z"),
    });
  });

  test("sustained overflow (three consecutive full pages, distinct created_at) strictly advances the cursor tick over tick — no livelock, no lost tasks", async () => {
    // Every tick queries with offset=0 (this source has no page token — just
    // `since`), so vary the response by an explicit tick counter instead.
    const ticksData = [
      [
        attioTaskRow({
          id: "task_a",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        attioTaskRow({
          id: "task_b",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:01:00.000Z",
        }),
      ],
      [
        attioTaskRow({
          id: "task_c",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:02:00.000Z",
        }),
        attioTaskRow({
          id: "task_d",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:03:00.000Z",
        }),
      ],
      [
        attioTaskRow({
          id: "task_e",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:04:00.000Z",
        }),
        attioTaskRow({
          id: "task_f",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:05:00.000Z",
        }),
      ],
    ];
    let tickIndex = 0;
    responder = () => {
      const data = ticksData[tickIndex]!;
      return jsonResponse(200, { data });
    };

    const cutoff = new Date("2026-07-01T00:00:00.000Z");
    let lastPollAt: Date | undefined;
    const cursors: Date[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await attioTaskSyncInboxSource.handle(
        baseCtx({
          cutoff,
          ...(lastPollAt !== undefined ? { lastPollAt } : {}),
          perSourceLimit: 2,
        }),
      );
      expect(result?.nextCursor).toBeDefined();
      const next = result?.nextCursor as Date;
      cursors.push(next);
      lastPollAt = next;
      tickIndex++;
    }

    expect(cursors[1]!.getTime()).toBeGreaterThan(cursors[0]!.getTime());
    expect(cursors[2]!.getTime()).toBeGreaterThan(cursors[1]!.getTime());

    const rows = await tasksForMember();
    expect(rows.map((r) => r.sourceRef).sort()).toEqual(
      [
        "attio:task:task_a",
        "attio:task:task_b",
        "attio:task:task_c",
        "attio:task:task_d",
        "attio:task:task_e",
        "attio:task:task_f",
      ].sort(),
    );
  });

  test("a partial page reports no nextCursor (cursor advances)", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });

    const result = await attioTaskSyncInboxSource.handle(
      baseCtx({ perSourceLimit: 25 }),
    );

    expect(result).toBeUndefined();
  });

  test("skips a workspace-scope context (defensive no-op)", async () => {
    responder = () => {
      throw new Error("should not be called");
    };
    await attioTaskSyncInboxSource.handle({
      ...baseCtx(),
      scope: "workspace",
    } as never);
    expect(calls).toHaveLength(0);
  });
});

// CL-3630: paginate the listing so `seenTaskIds` reflects the full open set
// across pages within a tick, and bound deletion re-verification so a large
// gap between synced tasks and the listing cannot trigger a re-fetch storm.
describe("attioTaskSyncInboxSource: pagination (CL-3630)", () => {
  test("more open tasks than one page: every task across pages is synced, no false deletions", async () => {
    // 3 pages of 2 (perSourceLimit=2): page 3 is partial, so pagination stops
    // there rather than hitting the MAX_LIST_PAGES_PER_TICK cap.
    const pages = [
      [
        attioTaskRow({
          id: "task_1",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:00:00.000Z",
        }),
        attioTaskRow({
          id: "task_2",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:01:00.000Z",
        }),
      ],
      [
        attioTaskRow({
          id: "task_3",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:02:00.000Z",
        }),
        attioTaskRow({
          id: "task_4",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:03:00.000Z",
        }),
      ],
      [
        attioTaskRow({
          id: "task_5",
          assignees: [SELF_ATTIO_MEMBER_ID],
          createdAt: "2026-07-01T00:04:00.000Z",
        }),
      ],
    ];
    responder = (url) => {
      if (!url.includes("/v2/tasks?")) {
        throw new Error(`unexpected call: ${url}`);
      }
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      const page = offset / 2;
      return jsonResponse(200, { data: pages[page] ?? [] });
    };

    const result = await attioTaskSyncInboxSource.handle(
      baseCtx({ perSourceLimit: 2 }),
    );

    // Partial final page: pagination is authoritative, no truncation.
    expect(result).toBeUndefined();
    // Exactly 3 list calls (one per page) — no re-fetch storm.
    expect(calls.filter((c) => c.url.includes("/v2/tasks?"))).toHaveLength(3);

    const rows = await tasksForMember();
    expect(rows.map((r) => r.sourceRef).sort()).toEqual(
      [
        "attio:task:task_1",
        "attio:task:task_2",
        "attio:task:task_3",
        "attio:task:task_4",
        "attio:task:task_5",
      ].sort(),
    );
    // All 5 tasks were seen across pages this tick, so none of them should
    // have triggered an individual attio_get_task deletion re-check.
    expect(calls.some((c) => c.url.includes("/v2/tasks/task_"))).toBe(false);
  });

  test("a sustained backlog beyond the page cap reports a truncated nextCursor", async () => {
    // Every page is full (perSourceLimit=1) — pagination stops at the
    // MAX_LIST_PAGES_PER_TICK cap rather than looping forever.
    let callCount = 0;
    responder = (url) => {
      if (!url.includes("/v2/tasks?")) {
        throw new Error(`unexpected call: ${url}`);
      }
      callCount++;
      return jsonResponse(200, {
        data: [
          attioTaskRow({
            id: `task_${callCount}`,
            assignees: [SELF_ATTIO_MEMBER_ID],
            createdAt: `2026-07-01T00:00:${String(callCount).padStart(2, "0")}.000Z`,
          }),
        ],
      });
    };

    const result = await attioTaskSyncInboxSource.handle(
      baseCtx({ perSourceLimit: 1 }),
    );

    // Bounded call count — the page cap, not an unbounded loop.
    expect(callCount).toBeLessThanOrEqual(10);
    expect(result?.nextCursor).toBeInstanceOf(Date);
  });

  test("deletion re-verification is bounded per tick and spreads over ticks for a large backlog", async () => {
    // Seed 30 previously-synced open tasks, none present in this tick's
    // listing — a naive implementation would fire 30 individual
    // attio_get_task calls in one tick.
    responder = () =>
      jsonResponse(200, {
        data: Array.from({ length: 30 }, (_, i) =>
          attioTaskRow({
            id: `seed_${i}`,
            assignees: [SELF_ATTIO_MEMBER_ID],
            createdAt: "2026-07-01T00:00:00.000Z",
          }),
        ),
      });
    await attioTaskSyncInboxSource.handle(
      baseCtx({
        perSourceLimit: 100,
        cutoff: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );
    expect(await tasksForMember()).toHaveLength(30);

    calls = [];
    // Now every task is missing from the listing and every deletion check
    // would 404 — a naive implementation marks all 30 done in one tick.
    responder = (url) => {
      if (url.includes("/v2/tasks?")) {
        return jsonResponse(200, { data: [] });
      }
      if (url.includes("/v2/tasks/seed_")) {
        return jsonResponse(404, { message: "not found" });
      }
      throw new Error(`unexpected call: ${url}`);
    };
    await attioTaskSyncInboxSource.handle(
      baseCtx({
        perSourceLimit: 100,
        cutoff: new Date("2026-06-01T00:00:00.000Z"),
      }),
    );

    const getTaskCalls = calls.filter((c) => c.url.includes("/v2/tasks/seed_"));
    expect(getTaskCalls.length).toBeGreaterThan(0);
    expect(getTaskCalls.length).toBeLessThan(30);

    const doneCount = (await tasksForMember()).filter(
      (r) => r.status === "done",
    ).length;
    expect(doneCount).toBe(getTaskCalls.length);
    expect(doneCount).toBeLessThan(30);
  });
});

// CL-3577 review fix C: a member with no `attioMemberId` preference has no
// known Attio identity, so creation must be skipped entirely rather than
// falling through to sync every workspace task into their list.
describe("attioTaskSyncInboxSource: creation gating on attioMemberId (review fix C)", () => {
  test("(a) no attioMemberId + an unseen task: no task is created", async () => {
    await client.query(
      `DELETE FROM member_preferences WHERE tenant_id = $1 AND member_principal_id = $2`,
      [TENANT, MEMBER],
    );
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });

    await attioTaskSyncInboxSource.handle(baseCtx());

    expect(await tasksForMember()).toHaveLength(0);
  });

  test("(b) attioMemberId set, assignee matches: task is created", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [
          attioTaskRow({ id: "task_1", assignees: [SELF_ATTIO_MEMBER_ID] }),
        ],
      });

    await attioTaskSyncInboxSource.handle(baseCtx());

    expect(await tasksForMember()).toHaveLength(1);
  });

  test("(c) attioMemberId set, assignee does not match: task is not created", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [attioTaskRow({ id: "task_1", assignees: ["someone-else"] })],
      });

    await attioTaskSyncInboxSource.handle(baseCtx());

    expect(await tasksForMember()).toHaveLength(0);
  });
});
