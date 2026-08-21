// Route-level tests for the tenant-scoped skill registry surface —
// request parsing, grant gating, and the PUT /:name update round trip
// (CL-6355): a new version is created and the version it replaced stays
// restorable. Registry semantics themselves are covered in registry.test.ts.
import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";

import type { TenantEnv } from "@intx/hub-api";

import { createSkillRegistry } from "../src/registry";
import { createSkillRoutes } from "../src/routes";
import { createFakeSkillAccess, createFakeSkillAssets } from "./fakes";

const TENANT = { id: "tnt_1" };
const PRINCIPAL = { id: "prn_author" };

function buildApp(): Hono<TenantEnv> {
  const registry = createSkillRegistry({
    assets: createFakeSkillAssets(),
    access: createFakeSkillAccess(),
  });
  const routes = createSkillRoutes({
    registry,
    pinnedBy: {
      async resolve() {
        return [];
      },
    },
    requireGrant: () => async (_c, next) => {
      await next();
    },
  });
  const asTenant: MiddlewareHandler<TenantEnv> = async (c, next) => {
    c.set("tenant", TENANT as never);
    c.set("principal", PRINCIPAL as never);
    await next();
  };
  const app = new Hono<TenantEnv>();
  app.use("*", asTenant);
  app.route("/", routes);
  return app;
}

async function createSkill(app: Hono<TenantEnv>): Promise<void> {
  const response = await app.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "triage",
      description: "Sorts inbound issues.",
      body: "Read the report. Pick one label.",
      scope: "private",
    }),
  });
  expect(response.status).toBe(201);
}

test("PUT /:name creates a new version and leaves the prior one restorable", async () => {
  const app = buildApp();
  await createSkill(app);

  const updateResponse = await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Sorts inbound issues by severity.",
      body: "Read the report. Pick a severity label.",
    }),
  });
  expect(updateResponse.status).toBe(200);
  const updated = (await updateResponse.json()) as {
    skill: { description: string };
  };
  expect(updated.skill.description).toBe("Sorts inbound issues by severity.");

  const loadResponse = await app.request("/triage");
  const loaded = (await loadResponse.json()) as {
    skill: { body: string };
  };
  expect(loaded.skill.body).toBe("Read the report. Pick a severity label.");

  const versionsResponse = await app.request("/triage/versions");
  const versions = (await versionsResponse.json()) as {
    versions: { commitSha: string; current: boolean }[];
  };
  expect(versions.versions).toHaveLength(2);
  const priorVersion = versions.versions[1];
  expect(priorVersion?.current).toBe(false);

  const restoreResponse = await app.request("/triage/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commitSha: priorVersion?.commitSha }),
  });
  expect(restoreResponse.status).toBe(200);

  const restoredLoad = await app.request("/triage");
  const restored = (await restoredLoad.json()) as {
    skill: { body: string };
  };
  expect(restored.skill.body).toBe("Read the report. Pick one label.");
});

test("GET /:name/versions/:commitSha reads a prior version without cutting one", async () => {
  const app = buildApp();
  await createSkill(app);
  await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Sorts inbound issues.",
      body: "Read the report. Pick a severity label.",
    }),
  });

  const versions = (await (await app.request("/triage/versions")).json()) as {
    versions: { commitSha: string }[];
  };
  const prior = versions.versions[1]?.commitSha ?? "";

  const response = await app.request(`/triage/versions/${prior}`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { skill: { body: string } };
  expect(payload.skill.body).toBe("Read the report. Pick one label.");

  const after = (await (await app.request("/triage/versions")).json()) as {
    versions: { commitSha: string }[];
  };
  expect(after.versions).toHaveLength(2);
  const current = (await (await app.request("/triage")).json()) as {
    skill: { body: string };
  };
  expect(current.skill.body).toBe("Read the report. Pick a severity label.");
});

test("GET /:name/versions/:commitSha for an unknown commit is a 404", async () => {
  const app = buildApp();
  await createSkill(app);
  const response = await app.request("/triage/versions/deadbeef");
  expect(response.status).toBe(404);
});

async function headSha(app: Hono<TenantEnv>): Promise<string> {
  const versions = (await (await app.request("/triage/versions")).json()) as {
    versions: { commitSha: string }[];
  };
  return versions.versions[0]?.commitSha ?? "";
}

test("PUT /:name with the current head as expectedHeadSha saves", async () => {
  const app = buildApp();
  await createSkill(app);
  const response = await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Sorts inbound issues.",
      body: "Read the report. Pick a severity label.",
      expectedHeadSha: await headSha(app),
    }),
  });
  expect(response.status).toBe(200);
});

test("PUT /:name is a 409 when the skill moved on since the edit started", async () => {
  const app = buildApp();
  await createSkill(app);
  const staleSha = await headSha(app);

  // Somebody else saves first.
  await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Sorts inbound issues.",
      body: "Their version.",
    }),
  });

  const response = await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Sorts inbound issues.",
      body: "My version, written against the old head.",
      expectedHeadSha: staleSha,
    }),
  });
  expect(response.status).toBe(409);

  // The other person's version is still the current one — nothing buried.
  const current = (await (await app.request("/triage")).json()) as {
    skill: { body: string };
  };
  expect(current.skill.body).toBe("Their version.");
});

test("PUT /:name with a malformed expectedHeadSha is a 400", async () => {
  const app = buildApp();
  await createSkill(app);
  const response = await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      description: "Sorts inbound issues.",
      body: "x",
      expectedHeadSha: "not a sha",
    }),
  });
  expect(response.status).toBe(400);
});

test("GET /:name/versions/:commitSha refuses a version id that isn't one", async () => {
  const app = buildApp();
  await createSkill(app);
  // Path-shaped and over-long ids are refused at the boundary; a
  // well-shaped id that simply isn't in this skill's history is a 404.
  expect(
    (await app.request("/triage/versions/..%2F..%2Fetc%2Fpasswd")).status,
  ).toBe(400);
  expect((await app.request(`/triage/versions/${"a".repeat(65)}`)).status).toBe(
    400,
  );
  expect((await app.request("/triage/versions/commit9999")).status).toBe(404);
});

test("PUT /:name for an unknown skill is a 404", async () => {
  const app = buildApp();
  const response = await app.request("/does-not-exist", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "x", body: "y" }),
  });
  expect(response.status).toBe(404);
});

test("PUT /:name with a malformed body is a 400", async () => {
  const app = buildApp();
  await createSkill(app);
  const response = await app.request("/triage", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ description: "x" }),
  });
  expect(response.status).toBe(400);
});
