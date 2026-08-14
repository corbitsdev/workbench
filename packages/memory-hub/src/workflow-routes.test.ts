import { describe, expect, test } from "bun:test";

import type { ResolvedWorkflowRunScope } from "@corbits/artifacts-hub";

import {
  createUnavailableWorkflowMemoryRoutes,
  createWorkflowMemoryRoutes,
  type WorkflowMemoryRoutesStore,
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

function fakeStore(overrides: Partial<WorkflowMemoryRoutesStore> = {}) {
  const calls: {
    method: "search" | "add" | "list";
    scope: ResolvedWorkflowRunScope;
    input: unknown;
  }[] = [];
  const store: WorkflowMemoryRoutesStore = {
    async search(scope, input) {
      calls.push({ method: "search", scope, input });
      return { items: [] };
    },
    async add(scope, input) {
      calls.push({ method: "add", scope, input });
      return { documentId: "doc_1", versionId: "ver_1" };
    },
    async list(scope, limit) {
      calls.push({ method: "list", scope, input: { limit } });
      return [];
    },
    ...overrides,
  };
  return { store, calls };
}

function appFor(store: WorkflowMemoryRoutesStore) {
  return createWorkflowMemoryRoutes({
    authenticator: {
      async resolve(token, address) {
        if (token === GOOD_TOKEN && address === GOOD_ADDRESS) return SCOPE;
        return null;
      },
    },
    store,
  });
}

describe("createWorkflowMemoryRoutes auth", () => {
  test("rejects a request with no bearer token", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/list", {
      headers: { "x-workflow-run-address": GOOD_ADDRESS },
    });
    expect(res.status).toBe(401);
  });

  test("rejects a request with a wrong run address — never scopes to the caller's claimed tenant", async () => {
    const { store, calls } = fakeStore();
    const res = await appFor(store).request("/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": "someone-else@workflow",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "q" }),
    });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /add", () => {
  test("adds a memory entry scoped to the authenticated run's tenant + principal, never the body", async () => {
    const { store, calls } = fakeStore();
    const res = await appFor(store).request("/add", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      // A malicious/confused caller naming a different tenant in the body
      // must never override the authenticated scope.
      body: JSON.stringify({
        title: "Note",
        text: "hello",
        tenantId: OTHER_SCOPE.tenantId,
        principalId: OTHER_SCOPE.principalId,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { documentId: string; versionId: string };
    };
    expect(body.data).toEqual({ documentId: "doc_1", versionId: "ver_1" });
    expect(calls).toEqual([
      { method: "add", scope: SCOPE, input: { title: "Note", text: "hello" } },
    ]);
  });

  test("rejects a body missing required fields", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/add", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Note" }),
    });
    expect(res.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/add", {
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
});

describe("POST /search", () => {
  test("searches scoped to the authenticated run, defaulting the limit", async () => {
    const { store, calls } = fakeStore();
    const res = await appFor(store).request("/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "what did we decide" }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        method: "search",
        scope: SCOPE,
        input: { query: "what did we decide", limit: 8, kinds: undefined },
      },
    ]);
  });

  test("rejects an empty query", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/search", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /list", () => {
  test("lists scoped to the authenticated run's tenant", async () => {
    const { store, calls } = fakeStore();
    const res = await appFor(store).request("/list?limit=5", {
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([
      { method: "list", scope: SCOPE, input: { limit: 5 } },
    ]);
  });
});

describe("createUnavailableWorkflowMemoryRoutes", () => {
  test("every route answers 503 when the memory plane is not mounted", async () => {
    const app = createUnavailableWorkflowMemoryRoutes();
    const search = await app.request("/search", { method: "POST" });
    const add = await app.request("/add", { method: "POST" });
    const list = await app.request("/list");
    expect(search.status).toBe(503);
    expect(add.status).toBe(503);
    expect(list.status).toBe(503);
  });
});
