import { describe, expect, test } from "bun:test";
import { createFakeDocumentStore, createMemory } from "@corbits/memory";
import type { ResolvedWorkflowRunScope } from "@corbits/artifacts-hub";

import {
  createUnavailableWorkflowMemoryRoutes,
  createWorkflowMemoryRoutes,
  createWorkflowMemoryStore,
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

  test("rejects text over 64,000 characters with a 413 that tells the model to shorten or split it", async () => {
    const { store, calls } = fakeStore();
    const res = await appFor(store).request("/add", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Note", text: "a".repeat(64_001) }),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("text_too_large");
    expect(body.error.userMessage).toMatch(/shorten|split/);
    expect(calls).toHaveLength(0);
  });

  test("accepts text at exactly the 64,000-character limit", async () => {
    const { store } = fakeStore();
    const res = await appFor(store).request("/add", {
      method: "POST",
      headers: {
        authorization: `Bearer ${GOOD_TOKEN}`,
        "x-workflow-run-address": GOOD_ADDRESS,
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Note", text: "a".repeat(64_000) }),
    });
    expect(res.status).toBe(201);
  });

  test("rejects the 31st add for the same run within a minute with a 429", async () => {
    const { store } = fakeStore();
    const app = appFor(store);
    const request = () =>
      app.request("/add", {
        method: "POST",
        headers: {
          authorization: `Bearer ${GOOD_TOKEN}`,
          "x-workflow-run-address": GOOD_ADDRESS,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Note", text: "hello" }),
      });

    for (let i = 0; i < 30; i++) {
      const res = await request();
      expect(res.status).toBe(201);
    }
    const limited = await request();
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.userMessage).toMatch(/wait/i);
  });

  test("rate-limits per run, not globally — a different run's 1st add still succeeds", async () => {
    const { store } = fakeStore();
    const app = createWorkflowMemoryRoutes({
      authenticator: {
        async resolve(token, address) {
          if (token !== GOOD_TOKEN) return null;
          if (address === GOOD_ADDRESS) return SCOPE;
          if (address === "run_2@workflow") return OTHER_SCOPE;
          return null;
        },
      },
      store,
    });
    const addFor = (address: string) =>
      app.request("/add", {
        method: "POST",
        headers: {
          authorization: `Bearer ${GOOD_TOKEN}`,
          "x-workflow-run-address": address,
          "content-type": "application/json",
        },
        body: JSON.stringify({ title: "Note", text: "hello" }),
      });

    for (let i = 0; i < 30; i++) {
      expect((await addFor(GOOD_ADDRESS)).status).toBe(201);
    }
    expect((await addFor(GOOD_ADDRESS)).status).toBe(429);
    expect((await addFor("run_2@workflow")).status).toBe(201);
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

describe("createWorkflowMemoryStore over the published @corbits/memory plane", () => {
  test("add/search/list go through createMemory + createFakeDocumentStore, scoped to tenant+principal", async () => {
    const memory = createMemory({
      documentStore: createFakeDocumentStore(),
    });
    try {
      const store = createWorkflowMemoryStore(memory);
      const added = await store.add(SCOPE, {
        title: "Decision A",
        text: "Tenant one shipped memory tools.",
      });
      expect(added.documentId).toMatch(/^fake_doc_/);
      await store.add(OTHER_SCOPE, {
        title: "Decision B",
        text: "Tenant two shipped memory tools.",
      });
      const found = await store.search(SCOPE, {
        query: "shipped memory tools",
      });
      expect(found.items.map((item) => item.title)).toEqual(["Decision A"]);
      const other = await store.search(OTHER_SCOPE, {
        query: "shipped memory tools",
      });
      expect(other.items.map((item) => item.title)).toEqual(["Decision B"]);
      const listed = await store.list(SCOPE, 8);
      expect(listed.map((event) => event.title)).toEqual(["Decision A"]);
    } finally {
      await memory.close();
    }
  });

  test("pins the published github @corbits/memory package, not a workbench-local store", async () => {
    const pkg = (await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json()) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@corbits/memory"]).toMatch(
      /^github:corbitsdev\/corbits-memory#/,
    );
  });
});
