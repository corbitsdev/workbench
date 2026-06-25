import { describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { HubDb } from "../db";

// Mock the user-context resolver at the module boundary: the router calls
// getRequestedUserContext(db, userId, requestedTenantId).
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

function makeDb(opts: { findMany?: unknown[]; findFirst?: unknown }): HubDb {
  const select = mock(() => {
    const chain = {
      from: mock(() => chain),
      where: mock(() => Promise.resolve([])),
    };
    return chain;
  });
  const db: MockDb = {
    query: {
      artifact: {
        findMany: mock(() => Promise.resolve(opts.findMany ?? [])),
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
  app.route("/", createArtifactsRouter(db));
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

describe("GET /artifacts", () => {
  it("returns serialized tenant artifacts with a null nextCursor under the page limit", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findMany: [ROW] }));

    const res = await app.request("/artifacts?tenantId=tn-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifacts: {
        id: string;
        title: string;
        createdAt: string;
        sessionName: null;
      }[];
      nextCursor: string | null;
    };
    expect(body.nextCursor).toBeNull();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.id).toBe("art-1");
    expect(body.artifacts[0]?.title).toBe("My Artifact");
    expect(body.artifacts[0]?.createdAt).toBe("2026-06-20T00:00:00.000Z");
    expect(body.artifacts[0]?.sessionName).toBeNull();
  });

  it("emits a nextCursor when results exceed the page limit", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...ROW,
      id: `art-${i}`,
    }));
    const app = appWith(makeDb({ findMany: rows }));

    const res = await app.request("/artifacts");
    const body = (await res.json()) as {
      artifacts: unknown[];
      nextCursor: string | null;
    };
    expect(body.artifacts).toHaveLength(20);
    expect(body.nextCursor).toBe("2026-06-20T00:00:00.000Z__art-19");
  });

  it("403s when the requested tenant is inaccessible", async () => {
    contextImpl = () => ({ context: null, forbidden: true });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts?tenantId=other");
    expect(res.status).toBe(403);
  });

  it("400s on an invalid status filter", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({}));
    const res = await app.request("/artifacts?status=bogus");
    expect(res.status).toBe(400);
  });
});

describe("GET /artifacts/:id/download", () => {
  it("404s for a missing artifact", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: undefined }));
    const res = await app.request("/artifacts/nope/download");
    expect(res.status).toBe(404);
  });

  it("400s when the kind is not downloadable", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(makeDb({ findFirst: { ...ROW, kind: "one-pager" } }));
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(400);
  });

  it("serves CSV for a csv-export artifact", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({
        findFirst: {
          ...ROW,
          kind: "csv-export",
          title: "Leads",
          content: "a,b\n1,2\n",
        },
      }),
    );
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("Leads.csv");
    expect(await res.text()).toBe("a,b\n1,2\n");
  });

  it("403s when the artifact belongs to another tenant", async () => {
    contextImpl = () => ({
      context: { tenantId: "tn-1", principalId: "prn-1" },
      forbidden: false,
    });
    const app = appWith(
      makeDb({
        findFirst: { ...ROW, tenantId: "tn-other", kind: "csv-export" },
      }),
    );
    const res = await app.request("/artifacts/art-1/download");
    expect(res.status).toBe(403);
  });
});
