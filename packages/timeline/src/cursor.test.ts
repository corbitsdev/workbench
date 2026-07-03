import { describe, expect, test } from "bun:test";

import { decodeTimelineCursor, encodeTimelineCursor } from "./cursor";

describe("timeline cursor", () => {
  test("round-trips the composite key", () => {
    const cursor = {
      timestamp: "2026-07-01T12:34:56.789Z",
      sourceTable: "workflow_run_record",
      id: "0b7e6f2a-1111-2222-3333-444455556666",
    };
    expect(decodeTimelineCursor(encodeTimelineCursor(cursor))).toEqual(cursor);
  });

  test("rejects a token that is not base64url JSON", () => {
    expect(() => decodeTimelineCursor("not a cursor !!!")).toThrow();
  });

  test("rejects a well-formed token with the wrong shape", () => {
    const token = Buffer.from(
      JSON.stringify({ timestamp: "2026-07-01T00:00:00.000Z" }),
    ).toString("base64url");
    expect(() => decodeTimelineCursor(token)).toThrow();
  });

  test("rejects a cursor with a non-timestamp timestamp", () => {
    const token = Buffer.from(
      JSON.stringify({ timestamp: "yesterday", sourceTable: "artifact", id: "x" }),
    ).toString("base64url");
    expect(() => decodeTimelineCursor(token)).toThrow();
  });
});
