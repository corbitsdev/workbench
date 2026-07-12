import { describe, expect, it, mock } from "bun:test";
import type { HubDb } from "../db";

let ownerResult: string | null = "principal-owner";
mock.module("../lib/artifact-tools", () => ({
  resolveOwnerMemberPrincipalId: async () => ownerResult,
}));

type StoreCall = { fn: string; args: Record<string, unknown> };
const storeCalls: StoreCall[] = [];
let updateResult: unknown = { id: "task-1" };
mock.module("../lib/task-store", () => ({
  createOwnerTask: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "create", args });
    return { id: "task-1", ...args };
  },
  updateOwnerTask: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "update", args });
    return updateResult;
  },
  listOwnerTasks: async (_db: unknown, args: Record<string, unknown>) => {
    storeCalls.push({ fn: "list", args });
    return [{ id: "task-1" }];
  },
}));

const { createTaskTools } = await import("./task-tools");

const context = {
  db: {} as unknown as HubDb,
  tenantId: "tenant-root",
  principalId: "principal-agent",
};

function tool(name: string) {
  const found = createTaskTools(context).find(
    (t) => t.definition.name === name,
  );
  if (!found) throw new Error(`tool not found: ${name}`);
  return found;
}

const signal = new AbortController().signal;

describe("task_create", () => {
  it("scopes to the resolved owner and attributes creation to the agent", async () => {
    ownerResult = "principal-owner";
    storeCalls.length = 0;
    const raw = await tool("task_create").handler(
      { title: "Prep follow-up", body: "context" },
      signal,
    );
    const created = JSON.parse(raw);
    expect(created.id).toBe("task-1");
    const call = storeCalls.find((c) => c.fn === "create");
    expect(call?.args).toMatchObject({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-owner",
      createdByPrincipalId: "principal-agent",
      title: "Prep follow-up",
      source: "agent",
    });
  });

  it("fails closed when the agent has no owning user", async () => {
    ownerResult = null;
    await expect(
      tool("task_create").handler({ title: "x" }, signal),
    ).rejects.toThrow(/no owning user/i);
  });
});

describe("task_update", () => {
  it("throws when no owned task matches", async () => {
    ownerResult = "principal-owner";
    updateResult = null;
    await expect(
      tool("task_update").handler(
        { taskId: "123e4567-e89b-42d3-a456-426614174000", status: "done" },
        signal,
      ),
    ).rejects.toThrow(/no task .* owned by you/i);
  });
});

describe("task_list", () => {
  it("returns an empty list when the agent has no owning user", async () => {
    ownerResult = null;
    const raw = await tool("task_list").handler({}, signal);
    expect(JSON.parse(raw)).toEqual({ tasks: [] });
  });

  it("scopes the list to the resolved owner with a status filter", async () => {
    ownerResult = "principal-owner";
    storeCalls.length = 0;
    await tool("task_list").handler({ status: "open" }, signal);
    const call = storeCalls.find((c) => c.fn === "list");
    expect(call?.args).toMatchObject({
      tenantId: "tenant-root",
      ownerPrincipalId: "principal-owner",
      statuses: ["open"],
    });
  });
});
