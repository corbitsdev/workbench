import { describe, expect, test } from "bun:test";

import type { SerializedArtifact } from "@corbits/artifacts";
import type { ResolvedWorkflowRunScope } from "./workflow-auth";
import {
  createUnavailableWorkflowArtifactRoutes,
  createWorkflowArtifactRoutes,
  MAX_WORKFLOW_BINARY_BYTES,
  type CreateWorkflowArtifactInput,
  type CreateWorkflowBinaryArtifactInput,
  type CreatedWorkflowArtifact,
  type WorkflowArtifactRoutesStore,
} from "./workflow-routes";

const SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "ten_1",
  principalId: "prn_1",
  runId: "run_1",
};

const OTHER_SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "ten_2",
  principalId: "prn_2",
  runId: "run_2",
};

const GOOD_TOKEN = "sidecar-token";
const GOOD_ADDRESS = "run_1@workflow";
const OTHER_TOKEN = "sidecar-token-2";
const OTHER_ADDRESS = "run_2@workflow";

function fakeStore(overrides: Partial<WorkflowArtifactRoutesStore> = {}) {
  const created: {
    scope: ResolvedWorkflowRunScope;
    input: CreateWorkflowArtifactInput;
  }[] = [];
  const createdBinary: {
    scope: ResolvedWorkflowRunScope;
    input: CreateWorkflowBinaryArtifactInput;
  }[] = [];
  const store: WorkflowArtifactRoutesStore = {
    async create(scope, input) {
      created.push({ scope, input });
      return { id: "art_1", version: 1 } satisfies CreatedWorkflowArtifact;
    },
    async listRecent() {
      return [];
    },
    async get() {
      return null;
    },
    async createBinary(scope, input) {
      createdBinary.push({ scope, input });
      return { id: "art_pdf_1", version: 1 } satisfies CreatedWorkflowArtifact;
    },
    ...overrides,
  };
  return { store, created, createdBinary };
}

/**
 * Stands in for `createWorkflowArtifactDbStore`'s real fetch-then-check
 * tenant scoping (`row.tenantId !== scope.tenantId` -> not found) — an
 * in-memory table of artifacts keyed by their true owning tenant, so a
 * test authenticated as one run's scope genuinely cannot read a row
 * seeded under another tenant, the same way the production store can't.
 */
function fakeTenantScopedStore(
  rows: readonly { id: string; tenantId: string; artifact: SerializedArtifact }[],
) {
  const store: WorkflowArtifactRoutesStore = {
    async create() {
      throw new Error("not used in this test");
    },
    async listRecent() {
      return [];
    },
    async get(scope, artifactId) {
      const row = rows.find((r) => r.id === artifactId);
      if (row === undefined || row.tenantId !== scope.tenantId) return null;
      return row.artifact;
    },
    async createBinary() {
      throw new Error("not used in this test");
    },
  };
  return store;
}

function serializedArtifactFixture(
  overrides: Partial<SerializedArtifact> = {},
): SerializedArtifact {
  return {
    id: "art_1",
    kind: "text",
    title: "Due diligence brief",
    content: "# Findings\n...",
    source: { origin: "workflow" },
    version: 1,
    ownerPrincipalId: null,
    ownerName: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function twoTenantAuthenticator() {
  return {
    async resolve(token: string, address: string) {
      if (token === GOOD_TOKEN && address === GOOD_ADDRESS) return SCOPE;
      if (token === OTHER_TOKEN && address === OTHER_ADDRESS) return OTHER_SCOPE;
      return null;
    },
  };
}

function appFor(
  store: WorkflowArtifactRoutesStore,
  authenticator: {
    resolve(
      token: string,
      address: string,
    ): Promise<ResolvedWorkflowRunScope | null>;
  } = {
    async resolve(token, address) {
      if (token === GOOD_TOKEN && address === GOOD_ADDRESS) return SCOPE;
      return null;
    },
  },
) {
  return createWorkflowArtifactRoutes({
    authenticator,
    store,
  });
}

describe("createWorkflowArtifactRoutes auth", () => {
  test("rejects a request with no bearer token", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/recent", {
      headers: { "x-workflow-run-address": GOOD_ADDRESS },
    });
    expect(res.status).toBe(401);
  });

  test("rejects a request with a wrong run address", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/recent", {
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": "someone-else@workflow",
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("POST / (create)", () => {
  test("creates an artifact scoped to the authenticated run and returns id/version", async () => {
    const { store, created } = fakeStore();
    const res = await appFor(store).request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Notes", kind: "text", content: "hello" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: CreatedWorkflowArtifact };
    expect(body.data).toEqual({ id: "art_1", version: 1 });
    expect(created).toEqual([
      {
        scope: SCOPE,
        input: { title: "Notes", kind: "text", content: "hello" },
      },
    ]);
  });

  test("rejects a body missing required fields", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Notes" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("rejects content over 64,000 characters with a 413 that tells the model to shorten or split it", async () => {
    const { store, created } = fakeStore();
    const res = await appFor(store).request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Notes",
        kind: "text",
        content: "a".repeat(64_001),
      }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("content_too_large");
    expect(body.error.message).toMatch(/shorten|split/);
    expect(created).toHaveLength(0);
  });

  test("accepts content at exactly the 64,000-character limit", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "Notes",
        kind: "text",
        content: "a".repeat(64_000),
      }),
    });
    expect(res.status).toBe(201);
  });

  test("rejects the 31st create for the same run within a minute with a 429", async () => {
    const { store } = fakeStore();
    const app = appFor(store);
    const request = () =>
      app.request("/", {
        method: "POST",
        headers: {
          authorization: `Bearer ${GOOD_TOKEN}`,
          "x-workflow-run-address": GOOD_ADDRESS,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Notes", kind: "text", content: "hi" }),
      });

    for (let i = 0; i < 30; i++) {
      const res = await request();
      expect(res.status).toBe(201);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toMatch(/wait/i);
  });
});

describe("GET /recent (list)", () => {
  test("lists recent artifacts for the authenticated run's tenant", async () => {
    const { store } = fakeStore({
      async listRecent(scope, limit) {
        expect(scope).toEqual(SCOPE);
        expect(limit).toBe(10);
        return [
          {
            id: "art_1",
            kind: "text",
            title: "Notes",
            source: { origin: "workflow" },
            version: 1,
            ownerPrincipalId: null,
            ownerName: null,
            archivedAt: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ];
      },
    });
    const res = await appFor(store).request("/recent", {
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  test("clamps an out-of-range limit into range", async () => {
    const { store } = fakeStore({
      async listRecent(_scope, limit) {
        expect(limit).toBe(50);
        return [];
      },
    });
    const res = await appFor(store).request("/recent?limit=9999", {
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
      },
    });
    expect(res.status).toBe(200);
  });
});

describe("GET /:id (read back)", () => {
  test("a run can read back an artifact it wrote", async () => {
    const artifact = serializedArtifactFixture({
      id: "art_1",
      content: "# Brief\nfindings here",
    });
    const store = fakeTenantScopedStore([
      { id: "art_1", tenantId: SCOPE.tenantId, artifact },
    ]);
    const res = await appFor(store).request("/art_1", {
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: SerializedArtifact };
    expect(body.data).toEqual(artifact);
  });

  test("a run cannot read an artifact belonging to another tenant", async () => {
    const artifact = serializedArtifactFixture({
      id: "art_owned_by_other_tenant",
      content: "someone else's brief",
    });
    const store = fakeTenantScopedStore([
      { id: "art_owned_by_other_tenant", tenantId: OTHER_SCOPE.tenantId, artifact },
    ]);
    const res = await appFor(store, twoTenantAuthenticator()).request(
      "/art_owned_by_other_tenant",
      {
        headers: {
          authorization: `Bearer ${GOOD_TOKEN}`,
          "x-workflow-run-address": GOOD_ADDRESS,
        },
      },
    );
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("someone else's brief");
  });

  test("answers 404 for an id that does not exist", async () => {
    const store = fakeTenantScopedStore([]);
    const res = await appFor(store).request("/does-not-exist", {
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
      },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /binary (create binary artifact)", () => {
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

  test("round-trips binary content through base64 to the store", async () => {
    const { store, createdBinary } = fakeStore();
    const res = await appFor(store).request("/binary", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "brief.pdf",
        mimeType: "application/pdf",
        contentBase64: Buffer.from(pdfBytes).toString("base64"),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: CreatedWorkflowArtifact };
    expect(body.data).toEqual({ id: "art_pdf_1", version: 1 });
    expect(createdBinary).toHaveLength(1);
    expect(createdBinary[0]?.scope).toEqual(SCOPE);
    expect(createdBinary[0]?.input.filename).toBe("brief.pdf");
    expect(createdBinary[0]?.input.mimeType).toBe("application/pdf");
    expect(Array.from(createdBinary[0]?.input.bytes ?? [])).toEqual(
      Array.from(pdfBytes),
    );
  });

  test("rejects oversized binary content with a clear error", async () => {
    const { store, createdBinary } = fakeStore();
    const oversized = new Uint8Array(MAX_WORKFLOW_BINARY_BYTES + 1);
    const res = await appFor(store).request("/binary", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        filename: "brief.pdf",
        mimeType: "application/pdf",
        contentBase64: Buffer.from(oversized).toString("base64"),
      }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("content_too_large");
    expect(body.error.message).toMatch(/byte/i);
    expect(createdBinary).toHaveLength(0);
  });

  test("rejects a body missing required fields", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/binary", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ filename: "brief.pdf" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("createUnavailableWorkflowArtifactRoutes", () => {
  test("every route answers 503", async () => {
    const app = createUnavailableWorkflowArtifactRoutes();
    const createRes = await app.request("/", { method: "POST" });
    const recentRes = await app.request("/recent");
    const getRes = await app.request("/some-id");
    const binaryRes = await app.request("/binary", { method: "POST" });
    expect(createRes.status).toBe(503);
    expect(recentRes.status).toBe(503);
    expect(getRes.status).toBe(503);
    expect(binaryRes.status).toBe(503);
  });
});
