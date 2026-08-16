import { expect, test } from "bun:test";

import {
  newToolCallsSince,
  readAllToolCalls,
  type SqlClientLike,
} from "./trace.ts";

function fakeSql(rows: Record<string, unknown>[]): SqlClientLike {
  return { unsafe: async () => rows };
}

function callRow(ordinal: number, callId: string, name: string, args: unknown) {
  return {
    metadata: { kind: "call", callId, name, arguments: args },
    ordinal,
    started_at: new Date(0),
  };
}

function resultRow(
  ordinal: number,
  callId: string,
  content: unknown,
  isError: boolean,
) {
  return {
    metadata: { kind: "result", callId, content, isError },
    ordinal,
    started_at: new Date(0),
  };
}

test("pairs a call with its result into one ToolCall", async () => {
  const sql = fakeSql([
    callRow(0, "c1", "memory_add", { content: "website: example.com" }),
    resultRow(1, "c1", "added", false),
  ]);
  const calls = await readAllToolCalls(sql, "tenant-1", "run-1");
  expect(calls).toEqual([
    {
      name: "memory_add",
      arguments: { content: "website: example.com" },
      isError: false,
      result: "added",
    },
  ]);
});

test("omits a call with no result yet (turn still in flight)", async () => {
  const sql = fakeSql([
    callRow(0, "c1", "create_agent", { name: "Researcher" }),
  ]);
  const calls = await readAllToolCalls(sql, "tenant-1", "run-1");
  expect(calls).toEqual([]);
});

test("preserves call order and marks a failed result", async () => {
  const sql = fakeSql([
    callRow(0, "c1", "request_connection", { connector: "attio" }),
    resultRow(1, "c1", "unknown connector: attio", true),
    callRow(2, "c2", "list_connections", {}),
    resultRow(3, "c2", "Connected: none.", false),
  ]);
  const calls = await readAllToolCalls(sql, "tenant-1", "run-1");
  expect(calls.map((c) => c.name)).toEqual([
    "request_connection",
    "list_connections",
  ]);
  expect(calls[0]?.isError).toBe(true);
  expect(calls[1]?.isError).toBe(false);
});

test("ignores non-tool turn_part rows (e.g. step-start, error parts)", async () => {
  const sql = fakeSql([
    { metadata: { model: "claude" }, ordinal: 0, started_at: new Date(0) },
    callRow(1, "c1", "memory_list", {}),
    resultRow(2, "c1", "[]", false),
  ]);
  const calls = await readAllToolCalls(sql, "tenant-1", "run-1");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.name).toBe("memory_list");
});

test("newToolCallsSince returns only the calls beyond what was already consumed", () => {
  const all = [
    { name: "a", arguments: {}, isError: false, result: "" },
    { name: "b", arguments: {}, isError: false, result: "" },
    { name: "c", arguments: {}, isError: false, result: "" },
  ];
  const first = newToolCallsSince(all.slice(0, 1), 0);
  expect(first.newCalls.map((c) => c.name)).toEqual(["a"]);
  expect(first.consumed).toBe(1);

  const second = newToolCallsSince(all, first.consumed);
  expect(second.newCalls.map((c) => c.name)).toEqual(["b", "c"]);
  expect(second.consumed).toBe(3);
});
