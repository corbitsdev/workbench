import { beforeEach, describe, expect, test } from "bun:test";
import type { RequireGrant } from "@intx/hub-api";
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

const allowAll: RequireGrant = () => async (_c, next) => {
  await next();
};

type Row = {
  id: string;
  kind: string;
  title: string;
  source: { origin: string };
  version: number;
  ownerPrincipalId: string;
  ownerName: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  content: string;
  _tenantId: string;
};

function sampleRow(id: string, tenantId: string, content = ""): Row {
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
    content,
    _tenantId: tenantId,
  };
}

function stripTenant(row: Row) {
  const { _tenantId: _t, ...rest } = row;
  return rest;
}

function memoryStore(): ArtifactRoutesStore & { rows: Row[] } {
  const rows: Row[] = [];
  return {
    rows,
    async list(tenantId, opts) {
      let data = rows
        .filter((r) => r._tenantId === tenantId)
        .map((r) => {
          const { content: _c, ...item } = stripTenant(r);
          return item;
        });
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
      return stripTenant(row);
    },
    async upload(
      tenantId: string,
      principalId: string,
      files: readonly ArtifactUploadInput[],
    ) {
      return files.map((file, index) => {
        const item = sampleRow(`up_${rows.length + index}`, tenantId);
        item.title = file.filename;
        item.ownerPrincipalId = principalId;
        item.content = new TextDecoder().decode(file.bytes);
        rows.push(item);
        return stripTenant(item);
      });
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
    createArtifactRoutes({ store, requireGrant: allowAll }),
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
    store.rows.push(sampleRow("a1", TENANT.id, "mine"));
    store.rows.push(sampleRow("b1", OTHER.id, "theirs"));
    const res = await app.request("/artifacts");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual(["a1"]);
  });

  test("GET /?q= filters by title", async () => {
    store.rows.push({
      ...sampleRow("a1", TENANT.id, "x"),
      title: "Quarterly report.pdf",
    });
    store.rows.push({
      ...sampleRow("a2", TENANT.id, "y"),
      title: "notes.txt",
    });
    const res = await app.request("/artifacts?q=report");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.map((r) => r.id)).toEqual(["a1"]);
  });

  test("GET /:id returns 404 for a foreign tenant row", async () => {
    store.rows.push(sampleRow("b1", OTHER.id, "secret"));
    const res = await app.request("/artifacts/b1");
    expect(res.status).toBe(404);
  });

  test("GET /:id returns the row for the calling tenant", async () => {
    store.rows.push(sampleRow("a1", TENANT.id, "hello"));
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

  test("GET /counts is all zero for a tenant with no artifacts", async () => {
    const res = await app.request("/artifacts/counts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      all: 0,
      document: 0,
      sheet: 0,
      pdf: 0,
      routine: 0,
    });
  });

  test("GET /counts buckets by kind segment and ignores other tenants", async () => {
    store.rows.push({
      ...sampleRow("doc1", TENANT.id),
      kind: "document",
      title: "brief",
    });
    store.rows.push({
      ...sampleRow("sheet1", TENANT.id),
      kind: "file",
      title: "budget.csv",
    });
    store.rows.push({
      ...sampleRow("pdf1", TENANT.id),
      kind: "pdf",
      title: "contract.pdf",
    });
    store.rows.push({
      ...sampleRow("routine1", TENANT.id),
      kind: "routine",
      title: "weekly digest",
    });
    store.rows.push({
      ...sampleRow("other-tenant", OTHER.id),
      kind: "document",
      title: "not mine",
    });
    const res = await app.request("/artifacts/counts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      all: 4,
      document: 1,
      sheet: 1,
      pdf: 1,
      routine: 1,
    });
  });
});

describe("GET /counts pagination", () => {
  function paginatedStore(rows: Row[], pageLimit: number): ArtifactRoutesStore {
    return {
      async list(tenantId, opts) {
        const tenantRows = rows
          .filter((r) => r._tenantId === tenantId)
          .map((r) => {
            const { content: _c, ...item } = stripTenant(r);
            return item;
          });
        const offset =
          opts.cursor === null ? 0 : Number.parseInt(opts.cursor, 10);
        const limit = Math.min(opts.limit, pageLimit);
        const page = tenantRows.slice(offset, offset + limit);
        const nextOffset = offset + page.length;
        return {
          data: page,
          nextCursor:
            nextOffset < tenantRows.length ? String(nextOffset) : null,
        };
      },
      async get() {
        return null;
      },
      async upload() {
        return [];
      },
    };
  }

  test("walks every cursor page without double-counting or dropping a row at the boundary", async () => {
    const rows: Row[] = [];
    const expected = { all: 0, document: 0, sheet: 0, pdf: 0, routine: 0 };
    function rowKindAndTitle(i: number): { kind: string; title: string } {
      switch (i % 4) {
        case 0:
          return { kind: "document", title: `brief-${i}` };
        case 1:
          return { kind: "pdf", title: `contract-${i}.pdf` };
        case 2:
          return { kind: "routine", title: `digest-${i}` };
        default:
          return { kind: "file", title: `budget-${i}.csv` }; // sheet, by extension
      }
    }
    for (let i = 0; i < 250; i++) {
      const { kind, title } = rowKindAndTitle(i);
      rows.push({ ...sampleRow(`r${i}`, TENANT.id), kind, title });
      expected.all += 1;
      if (kind === "document") expected.document += 1;
      if (kind === "pdf") expected.pdf += 1;
      if (kind === "routine") expected.routine += 1;
      if (kind === "file") expected.sheet += 1;
    }
    // Store's own page size (25) is smaller than the route's per-page walk
    // limit (100, capped by MAX_LIMIT) so a real multi-page walk exercises
    // several boundaries, not just the one the route itself requests.
    const app = mount(paginatedStore(rows, 25));

    const res = await app.request("/artifacts/counts");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected);
  });

  test("answers 503 instead of a partial count when the tenant list exceeds the page cap", async () => {
    const neverEndingStore: ArtifactRoutesStore = {
      async list(_tenantId, opts) {
        const next =
          opts.cursor === null
            ? "1"
            : String(Number.parseInt(opts.cursor, 10) + 1);
        return { data: [], nextCursor: next };
      },
      async get() {
        return null;
      },
      async upload() {
        return [];
      },
    };
    const app = mount(neverEndingStore);

    const res = await app.request("/artifacts/counts");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("counts_unavailable");
  });

  test("answers 503 instead of hanging when the store's cursor stops advancing", async () => {
    const stuckCursorStore: ArtifactRoutesStore = {
      async list(_tenantId, opts) {
        const next = opts.cursor === null ? "A" : opts.cursor;
        return { data: [], nextCursor: next };
      },
      async get() {
        return null;
      },
      async upload() {
        return [];
      },
    };
    const app = mount(stuckCursorStore);

    const res = await app.request("/artifacts/counts");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("counts_unavailable");
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
    app.route("/artifacts", createUnavailableArtifactRoutes(allowAll));

    for (const path of [
      "/artifacts",
      "/artifacts/upload",
      "/artifacts/counts",
      "/artifacts/x",
    ]) {
      const method = path.endsWith("/upload") ? "POST" : "GET";
      const res = await app.request(path, { method });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unavailable");
    }
  });
});
