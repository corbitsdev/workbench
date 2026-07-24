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
  createWorkUnitQueue,
  DEFAULT_MAX_ATTEMPTS,
} from "./work-unit-queue";

const TENANT = "ten-wq";

let client: PGlite;
let db: HubDb;

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

describe("work unit queue", () => {
  test("enqueue is idempotent per (tenant, kind, key)", async () => {
    const queue = createWorkUnitQueue(db);
    const a = await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "artifact:a1:v1",
      payload: { artifactId: "a1" },
    });
    const b = await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "artifact:a1:v1",
      payload: { artifactId: "a1" },
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.id).toBe(a.id);
  });

  test("claimDue leases due units and second claim does not double-lease", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "agent_task_turn",
      idempotencyKey: "task:t1:turn:1",
      payload: { taskId: "t1" },
    });
    const first = await queue.claimDue({ workerId: "w1", limit: 10 });
    expect(first).toHaveLength(1);
    expect(first[0]?.status).toBe("leased");
    expect(first[0]?.leaseOwner).toBe("w1");

    const second = await queue.claimDue({ workerId: "w2", limit: 10 });
    expect(second).toHaveLength(0);
  });

  test("concurrent claim never double-leases the same unit", async () => {
    const queue = createWorkUnitQueue(db);
    for (let i = 0; i < 5; i++) {
      await queue.enqueue({
        tenantId: TENANT,
        kind: "knowledge_capture",
        idempotencyKey: `k-${i}`,
      });
    }

    const [a, b] = await Promise.all([
      queue.claimDue({ workerId: "w-a", limit: 10 }),
      queue.claimDue({ workerId: "w-b", limit: 10 }),
    ]);
    const ids = [...a, ...b].map((u) => u.id);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(ids).toHaveLength(5);
  });

  test("expired lease is reclaimable by another worker", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "agent_task_turn",
      idempotencyKey: "task:t2:turn:1",
    });
    const [claimed] = await queue.claimDue({
      workerId: "w1",
      limit: 1,
      leaseMs: 1,
    });
    expect(claimed).toBeDefined();
    await new Promise((r) => setTimeout(r, 15));

    const reclaimed = await queue.claimDue({ workerId: "w2", limit: 1 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.id).toBe(claimed!.id);
    expect(reclaimed[0]?.leaseOwner).toBe("w2");
  });

  test("expired-lease reclaim charges an attempt", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "agent_task_turn",
      idempotencyKey: "task:attempt-charge:turn:1",
      maxAttempts: 5,
    });
    const [claimed] = await queue.claimDue({
      workerId: "w1",
      limit: 1,
      leaseMs: 1,
    });
    expect(claimed!.attempts).toBe(0);
    await new Promise((r) => setTimeout(r, 15));

    const [reclaimed] = await queue.claimDue({ workerId: "w2", limit: 1 });
    expect(reclaimed).toBeDefined();
    expect(reclaimed!.id).toBe(claimed!.id);
    expect(reclaimed!.attempts).toBe(1);
  });

  test("a unit whose lease keeps expiring is dead-lettered at max_attempts and never handed out again", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "agent_task_turn",
      idempotencyKey: "task:never-acked:turn:1",
      maxAttempts: 3,
    });

    let last: Awaited<ReturnType<typeof queue.claimDue>>[number] | undefined;
    for (let i = 0; i < 3; i++) {
      const [claimed] = await queue.claimDue({
        workerId: `worker-${i}`,
        limit: 1,
        leaseMs: 1,
      });
      if (claimed) last = claimed;
      await new Promise((r) => setTimeout(r, 15));
    }

    expect(last).toBeDefined();
    const none = await queue.claimDue({ workerId: "final", limit: 1 });
    expect(none).toHaveLength(0);

    const dead = await queue.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.id).toBe(last!.id);
    expect(dead[0]?.attempts).toBe(3);
    expect(dead[0]?.lastError).toBe("lease expired");
    expect(dead[0]?.leaseOwner).toBeNull();
  });

  test("heartbeat extends lease so a slow worker is not reclaimed", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "slow-1",
    });
    const [claimed] = await queue.claimDue({
      workerId: "w1",
      limit: 1,
      leaseMs: 30,
    });
    expect(claimed).toBeDefined();

    const ok = await queue.heartbeat(claimed!.id, "w1", 60_000);
    expect(ok).toBe(true);

    await new Promise((r) => setTimeout(r, 40));
    const other = await queue.claimDue({ workerId: "w2", limit: 1 });
    expect(other).toHaveLength(0);
  });

  test("complete acks a leased unit", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "done-1",
    });
    const [claimed] = await queue.claimDue({ workerId: "w1", limit: 1 });
    await queue.complete(claimed!.id, "w1");
    const dead = await queue.listDead();
    expect(dead).toHaveLength(0);
    const health = await queue.health();
    expect(health.byStatus["done"]).toBe(1);
  });

  test("complete/fail no-op when worker is not the lease owner", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "fence-1",
    });
    const [claimed] = await queue.claimDue({ workerId: "w1", limit: 1 });
    await queue.complete(claimed!.id, "w2");
    let health = await queue.health();
    expect(health.byStatus["leased"]).toBe(1);
    expect(health.byStatus["done"]).toBeUndefined();
    await queue.fail(claimed!.id, "w2", "stolen");
    health = await queue.health();
    expect(health.byStatus["leased"]).toBe(1);
    await queue.complete(claimed!.id, "w1");
    health = await queue.health();
    expect(health.byStatus["done"]).toBe(1);
  });

  test("fail below max reverts to pending with backoff; at max marks dead", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "fail-1",
      maxAttempts: 2,
    });
    const [c1] = await queue.claimDue({ workerId: "w1", limit: 1 });
    await queue.fail(c1!.id, "w1", "boom-1");

    // Backed off into the future — not claimable yet.
    const none = await queue.claimDue({ workerId: "w1", limit: 1 });
    expect(none).toHaveLength(0);

    await client.exec(
      `UPDATE work_unit SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`,
    );
    const [c2] = await queue.claimDue({ workerId: "w1", limit: 1 });
    await queue.fail(c2!.id, "w1", "boom-2");

    const dead = await queue.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toBe(2);
    expect(dead[0]?.lastError).toBe("boom-2");
  });

  test("retryDead re-queues; discardDead is idempotent", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "agent_task_turn",
      idempotencyKey: "retry-1",
      maxAttempts: 1,
    });
    const [claimed] = await queue.claimDue({ workerId: "w1", limit: 1 });
    await queue.fail(claimed!.id, "w1", "gone");

    const retried = await queue.retryDead(claimed!.id);
    expect(retried).toBe(true);
    const again = await queue.claimDue({ workerId: "w2", limit: 1 });
    expect(again).toHaveLength(1);

    await queue.fail(again[0]!.id, "w2", "gone-again");
    expect(await queue.discardDead(again[0]!.id)).toBe(true);
    expect(await queue.discardDead(again[0]!.id)).toBe(true);
    expect(await queue.retryDead("00000000-0000-4000-8000-000000000099")).toBe(
      false,
    );
  });

  test("health reports depth and dead count", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "h1",
    });
    const h = await queue.health();
    expect(h.byStatus["pending"]).toBe(1);
    expect(h.deadCount).toBe(0);
    expect(h.oldestPendingAgeMs).not.toBeNull();
  });

  test("claimDue can filter by kind", async () => {
    const queue = createWorkUnitQueue(db);
    await queue.enqueue({
      tenantId: TENANT,
      kind: "knowledge_capture",
      idempotencyKey: "kc",
    });
    await queue.enqueue({
      tenantId: TENANT,
      kind: "agent_task_turn",
      idempotencyKey: "at",
    });
    const only = await queue.claimDue({
      workerId: "w1",
      limit: 10,
      kinds: ["agent_task_turn"],
    });
    expect(only).toHaveLength(1);
    expect(only[0]?.kind).toBe("agent_task_turn");
  });

  test("DEFAULT_MAX_ATTEMPTS is 8", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
  });
});
