import { describe, expect, test } from "bun:test";

import type { ResolvedWorkflowRunScope } from "./workflow-auth";
import {
  createUnavailableWorkflowArtifactRoutes,
  createWorkflowArtifactRoutes,
  type CreateWorkflowArtifactInput,
  type CreatedWorkflowArtifact,
  type WorkflowArtifactRoutesStore,
} from "./workflow-routes";

const SCOPE: ResolvedWorkflowRunScope = {
  tenantId: "ten_1",
  principalId: "prn_1",
  runId: "run_1",
};

const GOOD_TOKEN = "sidecar-token";
const GOOD_ADDRESS = "run_1@workflow";

function fakeStore(overrides: Partial<WorkflowArtifactRoutesStore> = {}) {
  const created: {
    scope: ResolvedWorkflowRunScope;
    input: CreateWorkflowArtifactInput;
  }[] = [];
  const store: WorkflowArtifactRoutesStore = {
    async create(scope, input) {
      created.push({ scope, input });
      return { id: "art_1", version: 1 } satisfies CreatedWorkflowArtifact;
    },
    async listRecent() {
      return [];
    },
    ...overrides,
  };
  return { store, created };
}

function appFor(store: WorkflowArtifactRoutesStore) {
  return createWorkflowArtifactRoutes({
    authenticator: {
      async resolve(token, address) {
        if (token === GOOD_TOKEN && address === GOOD_ADDRESS) return SCOPE;
        return null;
      },
    },
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

describe("createUnavailableWorkflowArtifactRoutes", () => {
  test("both routes answer 503", async () => {
    const app = createUnavailableWorkflowArtifactRoutes();
    const createRes = await app.request("/", { method: "POST" });
    const recentRes = await app.request("/recent");
    expect(createRes.status).toBe(503);
    expect(recentRes.status).toBe(503);
  });
});
