import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

let contextImpl: () => {
  context: { tenantId: string; principalId: string } | null;
  forbidden: boolean;
} = () => ({
  context: { tenantId: "tn-1", principalId: "prn-1" },
  forbidden: false,
});
mock.module("../lib/user-context", () => ({
  getRequestedUserContext: () => contextImpl(),
}));

import { createArtifactsRouter } from "./artifacts";

// biome-ignore lint/suspicious/noExplicitAny: structural test mock
type MockDb = any;

function makeDb(opts: { findFirst?: unknown }): HubDb {
  const select = mock(() => ({
    from: mock(() => ({
      where: mock(() => Promise.resolve([])),
    })),
  }));
  const db: MockDb = {
    query: {
      artifact: {
        findFirst: mock(() => Promise.resolve(opts.findFirst ?? undefined)),
      },
    },
    select,
  };
  return db as HubDb;
}

function appWith(db: HubDb): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    await next();
  });
  app.route(
    "/",
    createArtifactsRouter(
      db,
      {} as unknown as Parameters<typeof createArtifactsRouter>[1],
    ),
  );
  return app;
}

const ROW = {
  id: "art-1",
  tenantId: "tn-1",
  principalId: null,
  ownerPrincipalId: null,
  sessionId: null,
  parentId: null,
  painPointId: null,
  kind: "one-pager",
  title: "My Artifact",
  content: "hello",
  source: null,
  status: "draft" as const,
  version: 1,
  createdAt: new Date("2026-06-20T00:00:00.000Z"),
  updatedAt: new Date("2026-06-20T00:00:00.000Z"),
};

describe("GET /artifacts/:id", () => {
  it("returns one serialized artifact for an accessible tenant", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: ROW }));
    const res = await app.request("/artifacts/art-1?tenantId=tn-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifact: { id: string; title: string; sessionName: null };
    };
    expect(body.artifact.id).toBe("art-1");
    expect(body.artifact.title).toBe("My Artifact");
    expect(body.artifact.sessionName).toBeNull();
  });

  it("404s when the artifact does not exist", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: undefined }));
    const res = await app.request("/artifacts/nope");
    expect(res.status).toBe(404);
  });

  it("403s when the artifact belongs to another tenant", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({ findFirst: { ...ROW, tenantId: "tn-other" } }),
    );
    const res = await app.request("/artifacts/art-1?tenantId=tn-1");
    expect(res.status).toBe(403);
  });
});
