import { beforeEach, describe, expect, test } from "bun:test";
import type { Hono } from "hono";

import { createSkillRegistry } from "../src/registry";
import {
  createWorkflowSkillRoutes,
  type WorkflowRunAuthenticator,
  type WorkflowSkillsEnv,
} from "../src/workflow-routes";
import { createFakeSkillAccess, createFakeSkillAssets } from "./fakes";

const AUTHOR_TOKEN = "sidecar-token";
const AUTHOR_ADDRESS = "run-author@runs.example";
const TEAMMATE_ADDRESS = "run-teammate@runs.example";

const SCOPES: Record<string, { tenantId: string; principalId: string }> = {
  [AUTHOR_ADDRESS]: {
    tenantId: "tenant_1",
    principalId: "principal_author",
  },
  [TEAMMATE_ADDRESS]: {
    tenantId: "tenant_1",
    principalId: "principal_teammate",
  },
};

const authenticator: WorkflowRunAuthenticator = {
  async resolve(token, runAddress) {
    if (token !== AUTHOR_TOKEN) return null;
    return SCOPES[runAddress] ?? null;
  },
};

let app: Hono<WorkflowSkillsEnv>;

async function request(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    address?: string;
    token?: string;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${init.token ?? AUTHOR_TOKEN}`,
    "x-workflow-run-address": init.address ?? AUTHOR_ADDRESS,
    "content-type": "application/json",
  };
  return await app.request(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(async () => {
  const registry = createSkillRegistry({
    assets: createFakeSkillAssets(),
    access: createFakeSkillAccess(),
  });
  const author = { tenantId: "tenant_1", principalId: "principal_author" };
  await registry.create(author, {
    name: "triage",
    description: "Sorts inbound issues.",
    body: "Read the report. Pick one label.",
    scope: "private",
  });
  await registry.create(author, {
    name: "summarize",
    description: "Condenses a long thread.",
    body: "Collect decisions and owners.",
    scope: "tenant",
  });
  app = createWorkflowSkillRoutes({ authenticator, registry });
});

describe("authentication", () => {
  test("a request with no bearer token is rejected", async () => {
    const response = await app.request("/list");
    expect(response.status).toBe(401);
  });

  test("an unrecognized sidecar token is rejected", async () => {
    expect((await request("/list", { token: "wrong" })).status).toBe(401);
  });

  test("a token with no matching run address is rejected", async () => {
    expect(
      (await request("/list", { address: "unknown@runs.example" })).status,
    ).toBe(401);
  });
});

describe("list", () => {
  test("serves the calling run's own visible skills, index-only", async () => {
    const response = await request("/list");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { name: string; description: string; body?: string }[];
    };
    expect(body.data.map((s) => s.name).sort()).toEqual([
      "summarize",
      "triage",
    ]);
    expect(body.data[0]).not.toHaveProperty("body");
  });

  test("a different run's principal sees only the tenant-scoped skill", async () => {
    const response = await request("/list", { address: TEAMMATE_ADDRESS });
    const body = (await response.json()) as { data: { name: string }[] };
    expect(body.data.map((s) => s.name)).toEqual(["summarize"]);
  });
});

describe("search", () => {
  test("matches within the caller's own visibility", async () => {
    const response = await request("/search", {
      method: "POST",
      body: { query: "inbound" },
    });
    const body = (await response.json()) as { data: { name: string }[] };
    expect(body.data.map((s) => s.name)).toEqual(["triage"]);
  });

  test("a teammate's search cannot reach the author's private skill", async () => {
    const response = await request("/search", {
      method: "POST",
      body: { query: "inbound" },
      address: TEAMMATE_ADDRESS,
    });
    const body = (await response.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  test("a malformed body is a 400, never an unfiltered listing", async () => {
    const response = await request("/search", {
      method: "POST",
      body: { queries: "inbound" },
    });
    expect(response.status).toBe(400);
  });
});

describe("load", () => {
  test("returns the full skill body", async () => {
    const response = await request("/load", {
      method: "POST",
      body: { name: "triage" },
    });
    const body = (await response.json()) as { data: { body: string } };
    expect(body.data.body).toBe("Read the report. Pick one label.");
  });

  test("loading a skill the caller cannot see is a 404, never an empty body", async () => {
    const response = await request("/load", {
      method: "POST",
      body: { name: "triage" },
      address: TEAMMATE_ADDRESS,
    });
    expect(response.status).toBe(404);
  });
});

describe("create", () => {
  test("a request with no bearer token is rejected", async () => {
    const response = await app.request("/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "escalate",
        description: "Escalates blockers.",
        body: "Ping the on-call.",
      }),
    });
    expect(response.status).toBe(401);
  });

  test("creates a tenant-scoped skill regardless of the caller's own scope choice", async () => {
    const response = await request("/create", {
      method: "POST",
      body: {
        name: "escalate",
        description: "Escalates blockers.",
        body: "Ping the on-call.",
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { name: string; scope: string };
    };
    expect(body.data.name).toBe("escalate");
    expect(body.data.scope).toBe("tenant");

    const loaded = await request("/load", {
      method: "POST",
      body: { name: "escalate" },
      address: TEAMMATE_ADDRESS,
    });
    expect(loaded.status).toBe(200);
  });
});

describe("update", () => {
  test("a request with no bearer token is rejected", async () => {
    const response = await app.request("/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "summarize", body: "New body." }),
    });
    expect(response.status).toBe(401);
  });

  test("updating an unknown skill is a 404", async () => {
    const response = await request("/update", {
      method: "POST",
      body: { name: "does-not-exist", body: "New body." },
    });
    expect(response.status).toBe(404);
  });

  test("omitting description preserves the skill's current description", async () => {
    const response = await request("/update", {
      method: "POST",
      body: { name: "summarize", body: "Collect decisions, owners, dates." },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { description: string; body?: string };
    };
    expect(body.data.description).toBe("Condenses a long thread.");

    const loaded = await request("/load", {
      method: "POST",
      body: { name: "summarize" },
    });
    const loadedBody = (await loaded.json()) as { data: { body: string } };
    expect(loadedBody.data.body).toBe("Collect decisions, owners, dates.");
  });

  test("an explicit description replaces the skill's current one", async () => {
    const response = await request("/update", {
      method: "POST",
      body: {
        name: "summarize",
        body: "Collect decisions.",
        description: "Summarizes any thread.",
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { description: string } };
    expect(body.data.description).toBe("Summarizes any thread.");
  });
});
