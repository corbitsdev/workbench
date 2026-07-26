import { describe, expect, test } from "bun:test";
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { schema } from "../db";
import type { HubDb } from "../db";
import { createWorkUnitQueue } from "./work-unit-queue";
import {
  enqueueKnowledgeCaptureAfterWrite,
  knowledgeCaptureIdempotencyKey,
  knowledgeCaptureOutboxEnabled,
  runKnowledgeCaptureUnit,
} from "./knowledge-capture-outbox";

const TENANT = "ten-kc";

let client: PGlite;
let db: HubDb;
let prevFlag: string | undefined;

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
  if (prevFlag === undefined) {
    delete process.env["KNOWLEDGE_CAPTURE_OUTBOX"];
  } else {
    process.env["KNOWLEDGE_CAPTURE_OUTBOX"] = prevFlag;
  }
});

beforeEach(async () => {
  await client.exec(`DELETE FROM work_unit;`);
  prevFlag = process.env["KNOWLEDGE_CAPTURE_OUTBOX"];
});

describe("knowledge capture outbox", () => {
  test("idempotency key prefers sourceRef then contentHash then version", () => {
    expect(
      knowledgeCaptureIdempotencyKey({
        artifactId: "a1",
        sourceRef: "ext:1",
        version: 3,
      }),
    ).toBe("source:ext:1");
    expect(
      knowledgeCaptureIdempotencyKey({
        artifactId: "a1",
        contentHash: "abc",
        version: 3,
      }),
    ).toBe("artifact:a1:hash:abc");
    expect(
      knowledgeCaptureIdempotencyKey({ artifactId: "a1", version: 2 }),
    ).toBe("artifact:a1:v2");
  });

  test("flag off: enqueue is a no-op and product write path stays clean", async () => {
    process.env["KNOWLEDGE_CAPTURE_OUTBOX"] = "0";
    expect(knowledgeCaptureOutboxEnabled()).toBe(false);
    const queue = createWorkUnitQueue(db);
    const result = await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a1",
      version: 1,
    });
    expect(result.enqueued).toBe(false);
    const health = await queue.health();
    expect(health.byStatus["pending"] ?? 0).toBe(0);
  });

  test("flag on: enqueues idempotent work unit after product write", async () => {
    process.env["KNOWLEDGE_CAPTURE_OUTBOX"] = "true";
    const queue = createWorkUnitQueue(db);
    const a = await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a1",
      version: 1,
    });
    const b = await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a1",
      version: 1,
    });
    expect(a.enqueued).toBe(true);
    expect(a.id).toBeDefined();
    expect(b.id).toBe(a.id);

    const claimed = await queue.claimDue({
      workerId: "kc-worker",
      limit: 10,
      kinds: ["knowledge_capture"],
    });
    expect(claimed).toHaveLength(1);
  });

  test("product write path does not throw when capture runner would fail later", async () => {
    process.env["KNOWLEDGE_CAPTURE_OUTBOX"] = "1";
    const queue = createWorkUnitQueue(db);
    // Simulate a broken queue by wrapping enqueue to throw after first success
    // is not needed — enqueue itself must not throw to caller when DB works.
    const result = await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a-ok",
      version: 1,
    });
    expect(result.enqueued).toBe(true);

    const [unit] = await queue.claimDue({
      workerId: "w1",
      limit: 1,
      kinds: ["knowledge_capture"],
    });
    expect(unit).toBeDefined();

    let ran = false;
    await expect(
      runKnowledgeCaptureUnit({
        tenantId: unit!.tenantId,
        payload: unit!.payload,
        signal: new AbortController().signal,
        runner: async () => {
          ran = true;
          throw new Error("capture boom");
        },
      }),
    ).rejects.toThrow("capture boom");
    expect(ran).toBe(true);

    await queue.fail(unit!.id, "w1", "capture boom");
    // Force due for second attempt if needed
    await queue.retryDead(unit!.id); // no-op if not dead yet
  });

  test("max attempts marks unit dead without double-capture on re-enqueue", async () => {
    process.env["KNOWLEDGE_CAPTURE_OUTBOX"] = "1";
    const queue = createWorkUnitQueue(db);
    await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a-dead",
      version: 1,
    });
    // Re-enqueue same key does not duplicate
    await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a-dead",
      version: 1,
    });

    for (let i = 0; i < 8; i++) {
      await client.exec(
        `UPDATE work_unit SET next_attempt_at = now() - interval '1 second' WHERE status = 'pending'`,
      );
      const [u] = await queue.claimDue({
        workerId: "w1",
        limit: 1,
        kinds: ["knowledge_capture"],
      });
      if (!u) break;
      await queue.fail(u.id, "w1", `fail-${i}`);
    }

    const dead = await queue.listDead();
    expect(dead).toHaveLength(1);
    expect(dead[0]?.kind).toBe("knowledge_capture");

    // Re-enqueue of done/dead key does not create a second live unit
    await enqueueKnowledgeCaptureAfterWrite(queue, {
      tenantId: TENANT,
      artifactId: "a-dead",
      version: 1,
    });
    const health = await queue.health();
    expect(health.byStatus["pending"] ?? 0).toBe(0);
    expect(health.deadCount).toBe(1);
  });
});
