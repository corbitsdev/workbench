import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  createArtifactRoutes,
  createUnavailableArtifactRoutes,
  type ArtifactRoutesStore,
  type ArtifactUploadInput,
} from "./artifact-routes";

type Tenant = { id: string };
type Principal = { id: string };

type TestEnv = {
  Variables: {
    tenant: Tenant;
    principal: Principal;
  };
};

const TENANT = { id: "tenant_a" };
const OTHER = { id: "tenant_b" };
const PRINCIPAL = { id: "prin_1" };

function allowAllRequireGrant() {
  return () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  };
}

function sampleListItem(id: string, tenantId: string) {
  return {
    id,
    kind: "file",
    title: `doc-${id}.txt`,
    source: { origin: "library-upload" },
    version: 1,
    ownerPrincipalId: PRINCIPAL.id,
    ownerName: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    // tenantId is store-side only; list response omits it
    _tenantId: tenantId,
  };
}

function memoryStore(): ArtifactRoutesStore & {
  rows: Array<ReturnType<typeof sampleListItem> & { content: string }>;
} {
  const rows: Array<ReturnType<typeof sampleListItem> & { content: string }> =
    [];
  return {
    rows,
    async list(tenantId, opts) {
      let data = rows
        .filter((r) => r._tenantId === tenantId)
        .map(({ content: _c, _tenantId: _t, ...rest }) => rest);
      if (opts.query !== null) {
        const q = opts.query.toLowerCase();
        data = data.filter((r) => r.title.toLowerCase().includes(q));
      }
      return {
        data: data.slice(0, opts.limit),
        nextCursor: null,
      };
    },
    async get(tenantId, artifactId) {
      const row = rows.find(
        (r) => r.id === artifactId && r._tenantId === tenantId,
      );
      if (row === undefined) return null;
      const { _tenantId: _t, ...rest } = row;
      return rest;
    },
    async upload(
      tenantId: string,
      principalId: string,
      files: readonly ArtifactUploadInput[],
    ) {
      const created = files.map((file, index) => {
        const item = {
          ...sampleListItem(`up_${rows.length + index}`, tenantId),
          title: file.filename,
          ownerPrincipalId: principalId,
          content: new TextDecoder().decode(file.bytes),
        };
        rows.push(item);
        const { _tenantId: _t, ...rest } = item;
        return rest;
      });
      return created;
    },
  };
}

function mount(store: ArtifactRoutesStore) {
  const app = new Hono<TestEnv>();
  app.use("*", async (c, next) => {
    c.set("tenant", TENANT);
    c.set("principal", PRINCIPAL);
    await next();
  });
  app.route(
    "/artifacts",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createArtifactRoutes({
      store,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      requireGrant: allowAllRequireGrant() as any,
    }) as any,
  );
  return app;
}

describe("artifact routes", () => {
  let store: ReturnType<typeof memoryStore>;
  let app: ReturnType<typeof mount>;

  beforeEach(() => {
    store = memoryStore();
    app = mount(store);
  });

  test("GET / lists empty data for a tenant with no artifacts", async () => {
    const res = await app.request("/artifacts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [], nextCursor: null });
  });

  test("GET / returns only the calling tenant's rows", async () => {
    store.rows.push({
      ...sampleListItem("a1", TENANT.id),
      content: "mine",
    });
    store.rows.push({
      ...sampleListItem("b1", OTHER.id),
      content: "theirs",
    });
    const res = await app.request("/artifacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual(["a1"]);
  });

  test("GET /?q= filters by title", async () => {
    store.rows.push({
      ...sampleListItem("a1", TENANT.id),
      title: "Quarterly report.pdf",
      content: "x",
    });
    store.rows.push({
      ...sampleListItem("a2", TENANT.id),
      title: "notes.txt",
      content: "y",
    });
    const res = await app.request("/artifacts?q=report");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual(["a1"]);
  });

  test("GET /:id returns 404 for a foreign tenant row", async () => {
    store.rows.push({
      ...sampleListItem("b1", OTHER.id),
      content: "secret",
    });
    const res = await app.request("/artifacts/b1");
    expect(res.status).toBe(404);
  });

  test("GET /:id returns the row for the calling tenant", async () => {
    store.rows.push({
      ...sampleListItem("a1", TENANT.id),
      content: "hello",
    });
    const res = await app.request("/artifacts/a1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; content: string };
    expect(body.id).toBe("a1");
    expect(body.content).toBe("hello");
  });

  test("POST /upload creates artifacts from multipart files", async () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["hello library"], "hello.txt", { type: "text/plain" }),
    );
    const res = await app.request("/artifacts/upload", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { title: string; content: string }[];
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.title).toBe("hello.txt");
    expect(body.data[0]?.content).toBe("hello library");
    expect(store.rows).toHaveLength(1);
  });

  test("POST /upload rejects an empty multipart body", async () => {
    const form = new FormData();
    form.append("note", "not a file");
    const res = await app.request("/artifacts/upload", {
      method: "POST",
      body: form,
    });
    expect(res.status).toBe(400);
  });
});

describe("unavailable artifact routes", () => {
  test("every surface answers 503", async () => {
    const app = new Hono<TestEnv>();
    app.use("*", async (c, next) => {
      c.set("tenant", TENANT);
      c.set("principal", PRINCIPAL);
      await next();
    });
    app.route(
      "/artifacts",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createUnavailableArtifactRoutes(allowAllRequireGrant() as any) as any,
    );

    for (const path of ["/artifacts", "/artifacts/upload", "/artifacts/x"]) {
      const method = path.endsWith("/upload") ? "POST" : "GET";
      const res = await app.request(path, { method });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unavailable");
    }
  });
});
