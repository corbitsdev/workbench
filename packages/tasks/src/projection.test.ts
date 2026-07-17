import { describe, expect, it } from "bun:test";
import {
  isTaskVisibleTo,
  toApiTask,
  toExternalRef,
  type TaskExternalRefRowLike,
  type TaskRowLike,
} from "./projection";

function baseRow(overrides?: Partial<TaskRowLike>): TaskRowLike {
  return {
    id: "task-1",
    tenantId: "ten-1",
    ownerPrincipalId: "pri-owner",
    createdByPrincipalId: "pri-owner",
    assigneePrincipalId: null,
    title: "Follow up",
    body: null,
    status: "open",
    source: "user",
    sourceRef: null,
    due: null,
    links: [],
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-07-02T00:00:00Z"),
    ...overrides,
  };
}

describe("toApiTask", () => {
  it("omits null-optional fields entirely rather than serializing them as null", () => {
    const task = toApiTask(baseRow(), []);
    expect(task).not.toHaveProperty("body");
    expect(task).not.toHaveProperty("sourceRef");
    expect(task).not.toHaveProperty("due");
    expect(task).not.toHaveProperty("assigneePrincipalId");
  });

  it("serializes optional fields when present", () => {
    const task = toApiTask(
      baseRow({
        body: "details",
        sourceRef: "row-1",
        due: new Date("2026-08-01T00:00:00Z"),
        assigneePrincipalId: "pri-assignee",
      }),
      [],
    );
    expect(task.body).toBe("details");
    expect(task.sourceRef).toBe("row-1");
    expect(task.due).toBe("2026-08-01T00:00:00.000Z");
    expect(task.assigneePrincipalId).toBe("pri-assignee");
  });

  it("only surfaces external refs that have an established external object", () => {
    const refs: TaskExternalRefRowLike[] = [
      {
        adapterId: "linear",
        externalId: "LIN-1",
        externalUrl: "https://linear.app/x/LIN-1",
        syncState: "synced",
        lastSyncedAt: new Date("2026-07-03T00:00:00Z"),
      },
      {
        adapterId: "attio",
        externalId: null,
        externalUrl: null,
        syncState: "pending",
        lastSyncedAt: null,
      },
    ];
    const task = toApiTask(baseRow(), refs);
    expect(task.externalRefs).toHaveLength(1);
    expect(task.externalRefs[0]).toMatchObject({
      adapterId: "linear",
      externalId: "LIN-1",
    });
  });
});

describe("toExternalRef", () => {
  it("defaults externalId to empty string when null", () => {
    const ref = toExternalRef({
      adapterId: "attio",
      externalId: null,
      externalUrl: null,
      syncState: "pending",
      lastSyncedAt: null,
    });
    expect(ref.externalId).toBe("");
    expect(ref).not.toHaveProperty("externalUrl");
    expect(ref).not.toHaveProperty("lastSyncedAt");
  });
});

describe("isTaskVisibleTo", () => {
  it("is visible to the owner", () => {
    expect(
      isTaskVisibleTo(
        { ownerPrincipalId: "pri-a", assigneePrincipalId: null },
        "pri-a",
      ),
    ).toBe(true);
  });

  it("is visible to the assignee", () => {
    expect(
      isTaskVisibleTo(
        { ownerPrincipalId: "pri-a", assigneePrincipalId: "pri-b" },
        "pri-b",
      ),
    ).toBe(true);
  });

  it("is not visible to an unrelated principal", () => {
    expect(
      isTaskVisibleTo(
        { ownerPrincipalId: "pri-a", assigneePrincipalId: "pri-b" },
        "pri-c",
      ),
    ).toBe(false);
  });
});
