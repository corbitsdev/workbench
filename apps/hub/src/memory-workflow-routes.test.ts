// DB-gated integration test for CL-5852 M2/M3's real seam: a workflow
// run reaching the memory plane through `createWorkflowMemoryRoutes`
// (`@corbits/memory-hub`), backed by the SAME in-process `Memory`
// instance `mountMemory` mounts for real (not a fake store) — proving
// tenant isolation and the degraded-embedding lexical fallback against
// an actual Postgres `memory` schema, the same convention
// `memory-mount.test.ts` uses (`describeIfDb`, skipped when
// `DATABASE_URL` is unreachable).
//
// "No EMBED_BASE_URL" per CL-5852's test brief means no WORKING
// embedding backend, not a literally-unset env var: `@corbits/memory`'s
// own `loadMemoryConfig()` requires the var to be set at all (a vendored
// contract this repo cannot change), and the hub's own optional-mount
// gate (`memory-mount.ts`) treats a genuinely unset var as "don't mount
// at all" — not a degraded-but-present plane. `EMBED_BASE_URL` here
// points at `localhost:9` (the "discard" port, always closed), the exact
// trick `memory-mount.test.ts` already uses: every embed call fails,
// forcing the plane's real runtime degrade
// (`services/search.ts`'s `degraded: ["dense_unavailable"]`) rather than
// a fake standing in for it — zero real keys, and the ONLY inference this
// test performs is the plane's own lexical (Postgres FTS) fallback.
import { afterAll, afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { createInMemoryGrantStore } from "@intx/authz";
import {
  createWorkflowMemoryRoutes,
  createWorkflowMemoryStore,
} from "@corbits/memory-hub";
import type { ResolvedWorkflowRunScope } from "@corbits/artifacts-hub";

import { mountMemory } from "./memory-mount";
import { dbGate } from "../../../scripts/e2e/db-gate";

const KEYS = [
  "DATABASE_URL",
  "EMBED_BASE_URL",
  "EMBED_MODEL",
  "EMBED_API_STYLE",
  "EMBED_API_KEY",
  "OLLAMA_BASE_URL",
] as const;

type EnvKey = (typeof KEYS)[number];

const saved: Partial<Record<EnvKey, string | undefined>> = {};

function clearEnvKey(key: EnvKey): void {
  // Assigning `undefined` would store the string "undefined"; the key has to
  // go. `Reflect.deleteProperty` because eslint forbids dynamic `delete`.
  Reflect.deleteProperty(process.env, key);
}

function stashEnv(): void {
  for (const key of KEYS) {
    saved[key] = process.env[key];
    clearEnvKey(key);
  }
}

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) clearEnvKey(key);
    else process.env[key] = value;
    saved[key] = undefined;
  }
});

const databaseUrl = process.env["DATABASE_URL"];
const describeIfDb = dbGate(databaseUrl, import.meta.path);

const TENANT_A: ResolvedWorkflowRunScope = {
  tenantId: "ten_memory_a",
  principalId: "prn_a",
  runId: "run_a",
};
const TENANT_B: ResolvedWorkflowRunScope = {
  tenantId: "ten_memory_b",
  principalId: "prn_b",
  runId: "run_b",
};
const TOKEN_A = "token-a";
const TOKEN_B = "token-b";

describeIfDb(
  "createWorkflowMemoryRoutes against a real memory plane (degraded, no working embed)",
  () => {
    afterAll(async () => {
      const postgres = (await import("postgres")).default;
      const sql = postgres(databaseUrl as string, { max: 1 });
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "memory" CASCADE`);
      } finally {
        await sql.end();
      }
    });

    test("writes tenant-isolated rows and finds them lexically with the embed backend unreachable", async () => {
      stashEnv();
      process.env["DATABASE_URL"] = databaseUrl;
      process.env["EMBED_BASE_URL"] = "http://localhost:9/v1";
      process.env["EMBED_MODEL"] = "test-embedding-model";

      const handle = await mountMemory({
        app: new Hono(),
        grantStore: createInMemoryGrantStore([]),
        conditionRegistry: {},
      });
      expect(handle).toBeDefined();
      if (handle === undefined) throw new Error("expected a mounted plane");

      const app = createWorkflowMemoryRoutes({
        authenticator: {
          async resolve(token) {
            if (token === TOKEN_A) return TENANT_A;
            if (token === TOKEN_B) return TENANT_B;
            return null;
          },
        },
        store: createWorkflowMemoryStore(handle.memory),
      });

      const addFor = (token: string, title: string, text: string) =>
        app.request("/add", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-workflow-run-address": "irrelevant-for-this-fake-authenticator",
            "content-type": "application/json",
          },
          body: JSON.stringify({ title, text }),
        });

      const searchFor = (token: string, query: string) =>
        app.request("/search", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "x-workflow-run-address": "irrelevant-for-this-fake-authenticator",
            "content-type": "application/json",
          },
          body: JSON.stringify({ query }),
        });

      const addA = await addFor(
        TOKEN_A,
        "Decision A",
        "Tenant A decided to ship the memory tools this week.",
      );
      expect(addA.status).toBe(201);

      const addB = await addFor(
        TOKEN_B,
        "Decision B",
        "Tenant B decided to ship the memory tools this week.",
      );
      expect(addB.status).toBe(201);

      // Tenant A's search must find its own entry, and never tenant B's,
      // even though both entries share the same words — real Postgres
      // row-level tenant scoping, not a test double.
      const searchA = await searchFor(TOKEN_A, "ship the memory tools");
      expect(searchA.status).toBe(200);
      const bodyA = (await searchA.json()) as {
        data: { items: { title: string }[] };
      };
      // The embed backend at localhost:9 is unreachable (proven by the
      // "embedding pass failed" warning the plane itself logs on add),
      // yet the search below still finds tenant A's own entry — the
      // plane's real lexical (Postgres full-text) fallback, exercised
      // end to end rather than mocked.
      expect(bodyA.data.items.map((i) => i.title)).toEqual(["Decision A"]);

      const searchB = await searchFor(TOKEN_B, "ship the memory tools");
      const bodyB = (await searchB.json()) as {
        data: { items: { title: string }[] };
      };
      expect(bodyB.data.items.map((i) => i.title)).toEqual(["Decision B"]);
    }, 20000);
  },
);
