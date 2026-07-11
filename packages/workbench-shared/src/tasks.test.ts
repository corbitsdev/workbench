import { describe, expect, it } from "bun:test";
import { type } from "arktype";

import {
  TaskExternalRefSchema,
  TaskLinkSchema,
  TaskListResponseSchema,
  TaskSchema,
  TaskSourceSchema,
  TaskStatusSchema,
  taskSources,
  taskStatuses,
  taskSyncStates,
} from "./tasks";

const validTask = {
  id: "11111111-1111-1111-1111-111111111111",
  tenantId: "tenant-1",
  ownerPrincipalId: "principal-owner",
  createdByPrincipalId: "principal-creator",
  title: "Follow up with Acme",
  status: "open" as const,
  source: "mail" as const,
  links: [],
  externalRefs: [],
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
};

describe("taskStatuses vocabulary", () => {
  it("is exactly the five lowest-common-denominator states", () => {
    expect([...taskStatuses]).toEqual([
      "open",
      "in_progress",
      "waiting",
      "done",
      "cancelled",
    ]);
  });

  it("has no `failed` state — failure lives on the sync ref, never on a task", () => {
    expect(taskStatuses).not.toContain("failed");
    const failed = TaskStatusSchema("failed");
    expect(failed).toBeInstanceOf(type.errors);
  });

  it("accepts every declared status and rejects an unknown one", () => {
    for (const status of taskStatuses) {
      expect(TaskStatusSchema(status)).toBe(status);
    }
    expect(TaskStatusSchema("archived")).toBeInstanceOf(type.errors);
  });
});

describe("taskSources vocabulary", () => {
  it("is the four origins a task can come from", () => {
    expect([...taskSources]).toEqual(["mail", "workflow", "agent", "user"]);
  });

  it("rejects an unknown source", () => {
    expect(TaskSourceSchema("slack")).toBeInstanceOf(type.errors);
  });
});

describe("TaskLinkSchema", () => {
  it("accepts a known link kind with a ref", () => {
    const link = TaskLinkSchema({ kind: "artifact", ref: "art-1" });
    expect(link).toEqual({ kind: "artifact", ref: "art-1" });
  });

  it("rejects an unknown link kind", () => {
    expect(TaskLinkSchema({ kind: "database", ref: "x" })).toBeInstanceOf(
      type.errors,
    );
  });
});

describe("TaskExternalRefSchema", () => {
  it("accepts a synced ref", () => {
    const ref = TaskExternalRefSchema({
      adapterId: "attio",
      externalId: "task_abc",
      syncState: "synced",
    });
    expect(ref).toMatchObject({ adapterId: "attio", syncState: "synced" });
  });

  it("constrains syncState to pending/synced/detached", () => {
    expect([...taskSyncStates]).toEqual(["pending", "synced", "detached"]);
    expect(
      TaskExternalRefSchema({
        adapterId: "attio",
        externalId: "task_abc",
        syncState: "errored",
      }),
    ).toBeInstanceOf(type.errors);
  });

  it("treats externalUrl and lastSyncedAt as optional so a pending ref validates", () => {
    const pending = TaskExternalRefSchema({
      adapterId: "attio",
      externalId: "",
      syncState: "pending",
    });
    expect(pending).not.toBeInstanceOf(type.errors);
  });

  it("does not declare an actor field — attribution stays server-side", () => {
    const ref = TaskExternalRefSchema({
      adapterId: "attio",
      externalId: "task_abc",
      syncState: "synced",
    });
    expect(ref).not.toBeInstanceOf(type.errors);
    if (!(ref instanceof type.errors)) {
      expect("actorPrincipalId" in ref).toBe(false);
    }
  });
});

describe("TaskSchema", () => {
  it("parses a well-formed task", () => {
    const parsed = TaskSchema(validTask);
    expect(parsed).toMatchObject({ id: validTask.id, status: "open" });
  });

  it("rejects a task carrying a `failed` status", () => {
    expect(TaskSchema({ ...validTask, status: "failed" })).toBeInstanceOf(
      type.errors,
    );
  });

  it("requires both the owner and the creator principal", () => {
    const { createdByPrincipalId: _omitCreator, ...withoutCreator } = validTask;
    expect(TaskSchema(withoutCreator)).toBeInstanceOf(type.errors);
    const { ownerPrincipalId: _omitOwner, ...withoutOwner } = validTask;
    expect(TaskSchema(withoutOwner)).toBeInstanceOf(type.errors);
  });

  it("carries nested links and external refs through", () => {
    const parsed = TaskSchema({
      ...validTask,
      links: [{ kind: "mail", ref: "mail-1", label: "Inbound" }],
      externalRefs: [
        { adapterId: "attio", externalId: "task_abc", syncState: "pending" },
      ],
    });
    expect(parsed).not.toBeInstanceOf(type.errors);
    if (!(parsed instanceof type.errors)) {
      expect(parsed.links[0]?.kind).toBe("mail");
      expect(parsed.externalRefs[0]?.adapterId).toBe("attio");
    }
  });
});

describe("TaskListResponseSchema", () => {
  it("wraps the page in an items array and omits nextCursor when absent", () => {
    const parsed = TaskListResponseSchema({ items: [validTask] });
    expect(parsed).not.toBeInstanceOf(type.errors);
    if (!(parsed instanceof type.errors)) {
      expect(parsed.items[0]?.id).toBe(validTask.id);
      expect("nextCursor" in parsed).toBe(false);
    }
  });

  it("carries an optional nextCursor and rejects a non-string one", () => {
    expect(TaskListResponseSchema({ items: [], nextCursor: "opaque" })).toEqual(
      { items: [], nextCursor: "opaque" },
    );
    expect(TaskListResponseSchema({ items: [], nextCursor: 7 })).toBeInstanceOf(
      type.errors,
    );
  });
});
