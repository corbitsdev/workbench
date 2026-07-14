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
import type { MemberInboxSourceContext } from "../inbox-source-registry";
import { attioTaskSyncInboxSource } from "./attio-task-sync";

const TENANT = "ten-attio";
const MEMBER = "prn-attio-member";

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
  calls = [];
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
    },
    credential: { apiKey: "tok", baseURL: "", source: "member" },
    cutoff: new Date("2026-07-01T00:00:00.000Z"),
    perSourceLimit: 25,
    signal: new AbortController().signal,
    log: { info() {}, warn() {}, error() {} } as never,
    deliverItems: async () => 0,
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
          data: [attioTaskRow({ id: "task_1" })],
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
      jsonResponse(200, { data: [attioTaskRow({ id: "task_1" })] });

    await attioTaskSyncInboxSource.handle(baseCtx());
    await attioTaskSyncInboxSource.handle(baseCtx());

    const rows = await tasksForMember();
    expect(rows).toHaveLength(1);
  });

  test("updates title and due date when the Attio task changes", async () => {
    responder = () =>
      jsonResponse(200, {
        data: [attioTaskRow({ id: "task_1", content: "Original title" })],
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
      jsonResponse(200, { data: [attioTaskRow({ id: "task_1" })] });
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
        return jsonResponse(200, { data: [attioTaskRow({ id: "task_1" })] });
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
      jsonResponse(200, { data: [attioTaskRow({ id: "task_1" })] });
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
      jsonResponse(200, { data: [attioTaskRow({ id: "task_1" })] });
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
