import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { schema } from "../db";
import type { HubDb } from "../db";
import {
  createGranolaCallJobQueue,
  MAX_ATTEMPTS,
} from "./granola-call-job-queue";

const TENANT = "ten-granola";

let client: PGlite;
let db: HubDb;

async function jobRows() {
  return client.query<{
    tenant_id: string;
    note_id: string;
    status: string;
    attempts: number;
    next_attempt_at: string;
  }>(
    `select tenant_id, note_id, status, attempts, next_attempt_at from granola_call_job`,
  );
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM granola_call_job;`);
});

describe("granola call job queue", () => {
  test("enqueue creates a pending job", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const rows = (await jobRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(0);
  });

  test("enqueue is idempotent per (tenant, note) — a re-listed note does not create a second job", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    await queue.enqueue(TENANT, "note-1");
    const rows = (await jobRows()).rows;
    expect(rows).toHaveLength(1);
  });

  test("claimDue returns due pending jobs and marks them processing", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    await queue.enqueue(TENANT, "note-2");

    const claimed = await queue.claimDue(10);
    expect(claimed.map((j) => j.noteId).sort()).toEqual(["note-1", "note-2"]);

    const rows = (await jobRows()).rows;
    expect(rows.every((r) => r.status === "processing")).toBe(true);
  });

  test("claimDue does not re-claim a job already claimed (processing)", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const first = await queue.claimDue(10);
    expect(first).toHaveLength(1);

    const second = await queue.claimDue(10);
    expect(second).toHaveLength(0);
  });

  test("complete marks a job done", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10);
    await queue.complete(job!.id);
    const rows = (await jobRows()).rows;
    expect(rows[0]?.status).toBe("done");
  });

  test("fail below the attempt ceiling reverts to pending with a future next_attempt_at (backoff)", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10);
    const before = Date.now();
    await queue.fail(job!.id, 1, "transient LLM error");
    const rows = (await jobRows()).rows;
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(1);
    expect(new Date(rows[0]!.next_attempt_at).getTime()).toBeGreaterThan(
      before,
    );
  });

  test("fail at the attempt ceiling marks the job dead instead of retrying forever", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10);
    await queue.fail(job!.id, MAX_ATTEMPTS, "still failing");
    const rows = (await jobRows()).rows;
    expect(rows[0]?.status).toBe("dead");
  });

  test("a backed-off job is not claimed again until its next_attempt_at passes", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10);
    await queue.fail(job!.id, 1, "transient");
    const reclaimed = await queue.claimDue(10);
    expect(reclaimed).toHaveLength(0);
  });
});
