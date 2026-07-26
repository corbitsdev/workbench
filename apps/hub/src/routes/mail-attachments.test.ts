import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

mock.module("../config", () => ({
  getConfig: () => ({}),
}));

import { Hono } from "hono";
import { createMailAttachmentsRouter } from "./mail-attachments";

function makeRequest(
  url: string,
  opts: { method?: string; body?: unknown; userId?: string } = {},
): Request {
  const { method = "POST", body, userId = "user-1" } = opts;
  return new Request(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "x-test-user-id": userId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const storedRefs = [
  {
    mailId: "mail-1",
    artifactId: "11111111-1111-1111-1111-111111111111",
    name: "report.pdf",
    type: "application/pdf",
    size: 1234,
  },
  {
    mailId: "mail-2",
    artifactId: "22222222-2222-2222-2222-222222222222",
    name: "pic.png",
    type: "image/png",
    size: 99,
  },
];

function makeDb(overrides: Partial<HubDb> = {}): HubDb {
  const fakePrincipal = {
    id: "pri-1",
    tenantId: "ten-1",
    kind: "user",
    refId: "user-1",
  };

  const db = {
    query: {
      principal: {
        findFirst: mock(async () => fakePrincipal),
      },
      agentInstance: {
        findFirst: mock(async () => ({ id: "ins-1", tenantId: "ten-1" })),
      },
      memberAgentInstance: {
        findFirst: mock(async () => ({
          instanceId: "ins-1",
          memberPrincipalId: "pri-1",
        })),
      },
    },
    insert: mock(() => ({
      values: mock(() => ({
        onConflictDoNothing: mock(() => Promise.resolve()),
      })),
    })),
    select: mock(() => ({
      from: mock(() => ({
        where: mock(async () => storedRefs),
      })),
    })),
    ...overrides,
  } as unknown as HubDb;

  return db;
}

function mountApp(db: HubDb) {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "");
    return next();
  });
  v1.route("/", createMailAttachmentsRouter(db));
  const app = new Hono();
  app.route("/api/v1", v1);
  return app;
}

const notFoundQuery = {
  agentInstance: { findFirst: mock(async () => null) },
  principal: { findFirst: mock(async () => null) },
  memberAgentInstance: { findFirst: mock(async () => null) },
} as unknown as HubDb["query"];

describe("POST /api/v1/instances/:instanceId/mail-attachments", () => {
  it("persists refs for a mail and returns 201", async () => {
    const db = makeDb();
    const app = mountApp(db);
    const res = await app.request(
      makeRequest("http://localhost/api/v1/instances/ins-1/mail-attachments", {
        body: {
          mailId: "mail-1",
          attachments: [
            {
              artifactId: "11111111-1111-1111-1111-111111111111",
              name: "report.pdf",
              type: "application/pdf",
              size: 1234,
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(201);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty attachments list", async () => {
    const app = mountApp(makeDb());
    const res = await app.request(
      makeRequest("http://localhost/api/v1/instances/ins-1/mail-attachments", {
        body: { mailId: "mail-1", attachments: [] },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a body missing mailId", async () => {
    const app = mountApp(makeDb());
    const res = await app.request(
      makeRequest("http://localhost/api/v1/instances/ins-1/mail-attachments", {
        body: {
          attachments: [{ artifactId: "a", name: "n", type: "t", size: 1 }],
        },
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the caller cannot access the instance", async () => {
    const app = mountApp(makeDb({ query: notFoundQuery }));
    const res = await app.request(
      makeRequest("http://localhost/api/v1/instances/ins-x/mail-attachments", {
        body: {
          mailId: "mail-1",
          attachments: [
            {
              artifactId: "a-1",
              name: "n.pdf",
              type: "application/pdf",
              size: 1,
            },
          ],
        },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/v1/instances/:instanceId/mail-attachments", () => {
  it("returns all persisted refs for the instance", async () => {
    const app = mountApp(makeDb());
    const res = await app.request(
      makeRequest("http://localhost/api/v1/instances/ins-1/mail-attachments", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refs: unknown[] };
    expect(body.refs).toEqual(storedRefs);
  });

  it("returns 404 when the caller cannot access the instance", async () => {
    const app = mountApp(makeDb({ query: notFoundQuery }));
    const res = await app.request(
      makeRequest("http://localhost/api/v1/instances/ins-x/mail-attachments", {
        method: "GET",
      }),
    );
    expect(res.status).toBe(404);
  });
});
