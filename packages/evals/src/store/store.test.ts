// Round-trips EvalRunResult through a real, uniquely-named scratch
// Postgres database — never the developer's own DATABASE_URL. Skips
// without DATABASE_URL (like every other real-Postgres suite in this
// repo); E2E_REQUIRED=1 turns that skip into a loud CI failure.
import { afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";

import { applyEvalsMigrations } from "./migrations.ts";
import { createPostgresEvalRunStore } from "./pg-store.ts";
import type { EvalRunResult } from "../types.ts";

function scratchDatabaseUrl(): string | undefined {
  const base = process.env["DATABASE_URL"];
  if (base === undefined || base === "") {
    if (process.env["E2E_REQUIRED"] === "1") {
      throw new Error(
        "E2E_REQUIRED=1 but DATABASE_URL is not set; the evals store " +
          "suite would be skipped. Set DATABASE_URL to a reachable " +
          "Postgres.",
      );
    }
    return undefined;
  }
  const url = new URL(base);
  const database = url.pathname.replace(/^\//, "");
  if (database === "") {
    throw new Error(`DATABASE_URL names no database (empty path): ${base}`);
  }
  const suffix = crypto.randomUUID().slice(0, 8);
  url.pathname = `/${database}_evals_store_${suffix}`;
  return url.toString();
}

const databaseUrl = scratchDatabaseUrl();

function fixtureResult(overrides: Partial<EvalRunResult> = {}): EvalRunResult {
  return {
    evalName: "ai-daily-research",
    configName: "default",
    startedAt: "2026-08-16T00:00:00.000Z",
    finishedAt: "2026-08-16T00:01:00.000Z",
    steps: [
      {
        stepIndex: 0,
        turn: { human: "hi", replyText: "hello", toolCalls: [] },
        scorerReports: [
          {
            name: "asksQuestions",
            score: 1,
            pass: true,
            reason: "ok",
            stepIndex: 0,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe.skipIf(databaseUrl === undefined)(
  "createPostgresEvalRunStore against a real scratch database",
  () => {
    const url = databaseUrl as string;
    let admin: ReturnType<typeof postgres>;

    afterAll(async () => {
      const database = new URL(url).pathname.replace(/^\//, "");
      const adminUrl = new URL(url);
      adminUrl.pathname = "/postgres";
      admin = postgres(adminUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}"`);
      await admin.end({ timeout: 5 });
    });

    test("migrates, saves a run, and reads it back by eval name", async () => {
      const database = new URL(url).pathname.replace(/^\//, "");
      const adminUrl = new URL(url);
      adminUrl.pathname = "/postgres";
      const bootstrap = postgres(adminUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      await bootstrap.unsafe(`CREATE DATABASE "${database}"`);
      await bootstrap.end({ timeout: 5 });

      const report = await applyEvalsMigrations(url);
      expect(report.applied).toContain("0001_run");

      const { store, close } = createPostgresEvalRunStore(url);
      try {
        const id = await store.save(fixtureResult());
        expect(id).toMatch(/^evalrun_/);

        const recent = await store.recent("ai-daily-research", 5);
        expect(recent).toHaveLength(1);
        expect(recent[0]?.id).toBe(id);
        expect(recent[0]?.evalName).toBe("ai-daily-research");
        expect(recent[0]?.configName).toBe("default");
        expect(recent[0]?.steps).toEqual(fixtureResult().steps);

        const other = await store.recent("docs-on-sdk-change", 5);
        expect(other).toHaveLength(0);

        const second = await store.save(
          fixtureResult({ evalName: "docs-on-sdk-change" }),
        );
        const across = await store.recentAcrossEvals(10);
        expect(across.map((r) => r.id).sort()).toEqual([id, second].sort());

        const fetched = await store.get(id);
        expect(fetched?.id).toBe(id);
        expect(fetched?.evalName).toBe("ai-daily-research");

        expect(await store.get("evalrun_does-not-exist")).toBeNull();
      } finally {
        await close();
      }
    }, 30_000);

    test("re-running migrations is idempotent", async () => {
      const first = await applyEvalsMigrations(url);
      expect(first.applied).toEqual([]);
      expect(first.alreadyApplied).toContain("0001_run");
    });
  },
);
