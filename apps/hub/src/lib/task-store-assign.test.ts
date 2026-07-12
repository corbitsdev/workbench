import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import { task, taskExternalRef, type TaskRow } from "../db/schema";

// Focused on the assignment seam of updateOwnerTask: mail fires on a real
// assignee CHANGE only (never a re-save of the same assignee, never a
// self-assignment), addressed to the new assignee. Everything else
// updateOwnerTask does (title/body/status/due) is exercised at the route
// level in me-tasks.test.ts; mocking the full drizzle chain for those too
// would just re-assert the same "blind set()" behavior already covered.

const deliverCalls: Record<string, unknown>[] = [];
mock.module("./deliver-task-mail", () => ({
  deliverTaskMail: async (args: Record<string, unknown>) => {
    deliverCalls.push(args);
  },
}));

const { updateOwnerTask } = await import("./task-store");

function baseRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "task-1",
    tenantId: "ten-1",
    ownerPrincipalId: "prn-owner",
    createdByPrincipalId: "prn-owner",
    assigneePrincipalId: null,
    title: "Follow up",
    body: null,
    status: "open",
    source: "user",
    sourceRef: null,
    due: null,
    links: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as TaskRow;
}

// A thenable that is also chainable via `.limit()`/`.orderBy()` — mirrors the
// shape of a drizzle query builder closely enough to stand in for both call
// patterns updateOwnerTask uses: `.where(...).limit(1)` (the pre-update
// assignee lookup) and a bare `await .where(...)` (loadRefsByTaskIds).
function chain<T>(result: T[]) {
  return Object.assign(Promise.resolve(result), {
    limit: (_n?: number) => chain(result),
    orderBy: (..._args: unknown[]) => chain(result),
  });
}

// A minimal stand-in for the drizzle query builder covering exactly the
// chains updateOwnerTask uses: a SELECT (used for the pre-update assignee
// lookup), an UPDATE...RETURNING, and the external-refs SELECT.
function makeDb(args: { priorRow: TaskRow | undefined; updatedRow: TaskRow }) {
  const db = {
    select: mock(() => ({
      from: mock((table: unknown) => ({
        where: mock(() => {
          if (table === taskExternalRef) return chain([]);
          if (table === task)
            return chain(args.priorRow ? [args.priorRow] : []);
          return chain([]);
        }),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => ({
          returning: mock(async () => [args.updatedRow]),
        })),
      })),
    })),
  } as unknown as HubDb;
  return db;
}

describe("updateOwnerTask assignment mail", () => {
  it("mails the new assignee when the assignee actually changes", async () => {
    deliverCalls.length = 0;
    const db = makeDb({
      priorRow: baseRow({ assigneePrincipalId: null }),
      updatedRow: baseRow({ assigneePrincipalId: "prn-bob" }),
    });
    await updateOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      actorPrincipalId: "prn-owner",
      id: "task-1",
      assigneePrincipalId: "prn-bob",
    });
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]).toMatchObject({
      event: "assigned",
      actorPrincipalId: "prn-owner",
      recipientPrincipalId: "prn-bob",
    });
  });

  it("does not mail when the assignee is re-saved unchanged", async () => {
    deliverCalls.length = 0;
    const db = makeDb({
      priorRow: baseRow({ assigneePrincipalId: "prn-bob" }),
      updatedRow: baseRow({ assigneePrincipalId: "prn-bob" }),
    });
    await updateOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      actorPrincipalId: "prn-owner",
      id: "task-1",
      assigneePrincipalId: "prn-bob",
    });
    expect(deliverCalls).toHaveLength(0);
  });

  it("does not mail when clearing the assignee (assigneePrincipalId: null)", async () => {
    deliverCalls.length = 0;
    const db = makeDb({
      priorRow: baseRow({ assigneePrincipalId: "prn-bob" }),
      updatedRow: baseRow({ assigneePrincipalId: null }),
    });
    await updateOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      actorPrincipalId: "prn-owner",
      id: "task-1",
      assigneePrincipalId: null,
    });
    expect(deliverCalls).toHaveLength(0);
  });

  it("does not mail a self-assignment (actor assigns the task to themself)", async () => {
    deliverCalls.length = 0;
    const db = makeDb({
      priorRow: baseRow({ assigneePrincipalId: null }),
      updatedRow: baseRow({ assigneePrincipalId: "prn-owner" }),
    });
    await updateOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      actorPrincipalId: "prn-owner",
      id: "task-1",
      assigneePrincipalId: "prn-owner",
    });
    // deliverTaskMail itself is mocked here (self-skip lives inside the real
    // implementation, covered in deliver-task-mail.test.ts) — this asserts
    // updateOwnerTask still calls through, with actor === recipient, so the
    // real deliverTaskMail's self-check is what suppresses the mail.
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0]).toMatchObject({
      actorPrincipalId: "prn-owner",
      recipientPrincipalId: "prn-owner",
    });
  });

  it("does not touch assignment mail when assigneePrincipalId is omitted from the patch", async () => {
    deliverCalls.length = 0;
    const db = makeDb({
      priorRow: undefined,
      updatedRow: baseRow({ status: "done" }),
    });
    await updateOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      actorPrincipalId: "prn-owner",
      id: "task-1",
      status: "done",
    });
    expect(deliverCalls).toHaveLength(0);
  });

  it("returns null and never mails when the pre-update assignee lookup finds no row", async () => {
    deliverCalls.length = 0;
    const db = makeDb({
      priorRow: undefined,
      updatedRow: baseRow({ assigneePrincipalId: "prn-bob" }),
    });
    const result = await updateOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      actorPrincipalId: "prn-owner",
      id: "task-1",
      assigneePrincipalId: "prn-bob",
    });
    expect(result).toBeNull();
    expect(deliverCalls).toHaveLength(0);
  });
});
