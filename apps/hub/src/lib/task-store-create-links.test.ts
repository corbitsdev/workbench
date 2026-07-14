import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";
import type { TaskRow } from "../db/schema";

const deliverCalls: Record<string, unknown>[] = [];
mock.module("./deliver-task-mail", () => ({
  deliverTaskMail: async (args: Record<string, unknown>) => {
    deliverCalls.push(args);
  },
}));

const { createOwnerTask, InvalidTaskLinksError } = await import("./task-store");

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

describe("createOwnerTask link validation", () => {
  it("rejects javascript: url links before insert", async () => {
    deliverCalls.length = 0;
    const insert = mock(async () => ({
      values: mock(() => ({
        returning: mock(async () => {
          throw new Error("insert should not run");
        }),
      })),
    }));
    const db = {
      insert: insert,
    } as unknown as HubDb;

    await expect(
      createOwnerTask(db, {
        tenantId: "ten-1",
        ownerPrincipalId: "prn-owner",
        createdByPrincipalId: "prn-owner",
        title: "x",
        source: "user",
        links: [{ kind: "url", ref: "javascript:alert(1)" }],
      }),
    ).rejects.toBeInstanceOf(InvalidTaskLinksError);

    expect(insert).not.toHaveBeenCalled();
    expect(deliverCalls).toHaveLength(0);
  });

  it("persists valid http(s) url links", async () => {
    deliverCalls.length = 0;
    const row = baseRow({
      links: [{ kind: "url", ref: "https://example.com/x" }],
    });
    const db = {
      insert: mock(() => ({
        values: mock(() => ({
          returning: mock(async () => [row]),
        })),
      })),
    } as unknown as HubDb;

    const created = await createOwnerTask(db, {
      tenantId: "ten-1",
      ownerPrincipalId: "prn-owner",
      createdByPrincipalId: "prn-owner",
      title: "Linked",
      source: "user",
      links: [{ kind: "url", ref: "https://example.com/x" }],
    });

    expect(created.links).toEqual([
      { kind: "url", ref: "https://example.com/x" },
    ]);
    expect(deliverCalls).toHaveLength(1);
  });
});