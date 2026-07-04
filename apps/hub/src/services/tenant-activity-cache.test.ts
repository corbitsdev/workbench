import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { TimelineCursor } from "@workbench/timeline";

type Page = { entries: { id: string }[]; nextCursor: TimelineCursor | null };

let calls: { tenantId: string; limit: number; cursor?: TimelineCursor }[] = [];
let nextResult: () => Page = () => ({
  entries: [{ id: "run-1" }],
  nextCursor: null,
});

mock.module("./principal-activity", () => ({
  getTenantActivityPage: mock(
    async (args: {
      db: unknown;
      tenantId: string;
      limit: number;
      cursor?: TimelineCursor;
    }): Promise<Page> => {
      calls.push({
        tenantId: args.tenantId,
        limit: args.limit,
        ...(args.cursor !== undefined ? { cursor: args.cursor } : {}),
      });
      return nextResult();
    },
  ),
}));

import {
  getCachedTenantActivityPage,
  resetTenantActivityCache,
} from "./tenant-activity-cache";

const db = {} as never;
const TTL = 45_000;

beforeEach(() => {
  calls = [];
  nextResult = () => ({ entries: [{ id: "run-1" }], nextCursor: null });
  resetTenantActivityCache();
});

describe("getCachedTenantActivityPage", () => {
  it("serves the tenant-wide first page from cache within the TTL (one DB hit)", async () => {
    const first = await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000,
    });
    const second = await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000 + TTL - 1,
    });

    expect(calls.length).toBe(1);
    expect(second).toBe(first);
  });

  it("re-queries once the TTL has elapsed", async () => {
    await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000,
    });
    await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000 + TTL + 1,
    });
    expect(calls.length).toBe(2);
  });

  it("stamps the TTL at query completion, not at query start", async () => {
    // Clock advances by nearly the full TTL *during* the union. A start-stamp
    // would record 1_000 and expire almost immediately; a completion-stamp
    // records the settle time so the entry lives the full configured TTL.
    let clock = 1_000;
    const queryDurationMs = TTL - 1;
    nextResult = () => {
      clock += queryDurationMs;
      return { entries: [{ id: "run-1" }], nextCursor: null };
    };

    const first = await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => clock,
    });

    // completion time is 1_000 + (TTL - 1). A read one tick later is still in
    // TTL only if we stamped at completion; a start-stamp would already be
    // expired (elapsed = queryDurationMs + 1 > ... actually far past TTL).
    const second = await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => clock + 1,
    });

    expect(calls.length).toBe(1);
    expect(second).toBe(first);
  });

  it("keeps tenants isolated — a cached page never crosses the tenant boundary", async () => {
    nextResult = () => ({ entries: [{ id: "t1-row" }], nextCursor: null });
    const a = await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000,
    });
    nextResult = () => ({ entries: [{ id: "t2-row" }], nextCursor: null });
    const b = await getCachedTenantActivityPage({
      db,
      tenantId: "t2",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000,
    });

    expect(calls.length).toBe(2);
    expect(a.entries[0]!.id).toBe("t1-row");
    expect(b.entries[0]!.id).toBe("t2-row");
  });

  it("does not cache paginated (cursor) pages — every deep page hits the DB", async () => {
    const cursor: TimelineCursor = {
      timestamp: "2026-07-01T10:00:00.000000Z",
      sourceTable: "workflow_run_record",
      id: "run-1",
    };
    await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      cursor,
      ttlMs: TTL,
      now: () => 1_000,
    });
    await getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      cursor,
      ttlMs: TTL,
      now: () => 1_000,
    });
    expect(calls.length).toBe(2);
  });

  it("collapses concurrent first-page loads into a single DB query", async () => {
    let resolve!: (page: Page) => void;
    const pending = new Promise<Page>((r) => {
      resolve = r;
    });
    nextResult = () => pending as unknown as Page;

    const p1 = getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000,
    });
    const p2 = getCachedTenantActivityPage({
      db,
      tenantId: "t1",
      limit: 50,
      ttlMs: TTL,
      now: () => 1_000,
    });
    resolve({ entries: [{ id: "run-1" }], nextCursor: null });
    await Promise.all([p1, p2]);
    expect(calls.length).toBe(1);
  });
});
