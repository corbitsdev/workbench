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
  GRANOLA_CALL_KIND,
  MAX_ATTEMPTS,
} from "./granola-call-job-queue";

const TENANT = "ten-granola";

let client: PGlite;
let db: HubDb;

async function unitRows() {
  return client.query<{
    tenant_id: string;
    kind: string;
    idempotency_key: string;
    status: string;
    attempts: number;
    next_attempt_at: string;
    payload: { noteId?: string };
  }>(
    `select tenant_id, kind, idempotency_key, status, attempts, next_attempt_at, payload
     from work_unit where kind = 'granola_call'`,
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
  await client.exec(`DELETE FROM work_unit;`);
});

describe("granola call job queue (work_unit kind)", () => {
  test("enqueue creates a pending granola_call work unit", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const rows = (await unitRows()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe(GRANOLA_CALL_KIND);
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.idempotency_key).toBe("note:note-1");
    expect(rows[0]?.payload?.noteId).toBe("note-1");
    expect(rows[0]?.attempts).toBe(0);
  });

  test("enqueue is idempotent per (tenant, note) — a re-listed note does not create a second unit", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    await queue.enqueue(TENANT, "note-1");
    const rows = (await unitRows()).rows;
    expect(rows).toHaveLength(1);
  });

  test("claimDue returns due pending jobs and marks them leased (processing facade)", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    await queue.enqueue(TENANT, "note-2");

    const claimed = await queue.claimDue(10);
    expect(claimed.map((j) => j.noteId).sort()).toEqual(["note-1", "note-2"]);
    expect(claimed.every((j) => j.status === "processing")).toBe(true);

    const rows = (await unitRows()).rows;
    expect(rows.every((r) => r.status === "leased")).toBe(true);
  });

  test("claimDue does not re-claim a job already claimed (leased)", async () => {
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
    await queue.complete(job!.id, "granola-runner");
    const rows = (await unitRows()).rows;
    expect(rows[0]?.status).toBe("done");
  });

  test("fail below the attempt ceiling reverts to pending with a future next_attempt_at (backoff)", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10);
    const before = Date.now();
    await queue.fail(job!.id, "granola-runner", "transient LLM error");
    const rows = (await unitRows()).rows;
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.attempts).toBe(1);
    expect(new Date(rows[0]!.next_attempt_at).getTime()).toBeGreaterThan(
      before,
    );
  });

  test("fail at the attempt ceiling marks the job dead instead of retrying forever", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const [job] = await queue.claimDue(10, `w-${i}`, 60_000);
      expect(job).toBeDefined();
      await queue.fail(job!.id, `w-${i}`, "still failing");
      // Clear backoff so the next claim is immediately due (not needed after dead).
      await client.exec(
        `UPDATE work_unit SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`,
      );
    }
    const rows = (await unitRows()).rows;
    expect(rows[0]?.status).toBe("dead");
    expect(rows[0]?.attempts).toBe(MAX_ATTEMPTS);
  });

  test("a backed-off job is not claimed again until its next_attempt_at passes", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10);
    await queue.fail(job!.id, "granola-runner", "transient");
    const reclaimed = await queue.claimDue(10);
    expect(reclaimed).toHaveLength(0);
  });

  test("complete/fail no-op when worker is not the lease owner", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-1");
    const [job] = await queue.claimDue(10, "owner-a");
    await queue.complete(job!.id, "owner-b");
    let rows = (await unitRows()).rows;
    expect(rows[0]?.status).toBe("leased");
    await queue.fail(job!.id, "owner-b", "stolen");
    rows = (await unitRows()).rows;
    expect(rows[0]?.status).toBe("leased");
    await queue.complete(job!.id, "owner-a");
    rows = (await unitRows()).rows;
    expect(rows[0]?.status).toBe("done");
  });

  test("expired processing lease is reclaimable (process death)", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-lease");
    const first = await queue.claimDue(10, "worker-a", 1);
    expect(first).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 15));
    const second = await queue.claimDue(10, "worker-b", 60_000);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
    expect(second[0]?.leaseOwner).toBe("worker-b");
  });

  test("heartbeat keeps a live lease from being reclaimed", async () => {
    const queue = createGranolaCallJobQueue(db);
    await queue.enqueue(TENANT, "note-hb");
    const [job] = await queue.claimDue(10, "worker-a", 40);
    expect(job).toBeDefined();
    const ok = await queue.heartbeat(job!.id, "worker-a", 60_000);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const other = await queue.claimDue(10, "worker-b", 60_000);
    expect(other).toHaveLength(0);
  });
});
