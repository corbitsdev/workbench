import { describe, expect, it } from "bun:test";
import {
  clampLimit,
  decodeCursor,
  encodeCursor,
  MAX_PAGE_LIMIT,
  takePage,
} from "./keyset";

const ROW = {
  createdAt: new Date("2026-07-10T07:00:00.000Z"),
  id: "5e0f8c9a-0000-4000-8000-000000000001",
};

describe("cursor encode/decode", () => {
  it("round-trips a keyset position", () => {
    expect(decodeCursor(encodeCursor(ROW))).toEqual({
      createdAt: "2026-07-10T07:00:00.000Z",
      id: ROW.id,
    });
  });

  it("rejects non-base64url garbage", () => {
    expect(decodeCursor("!!not-base64!!")).toBeNull();
  });

  it("rejects valid base64url that is not JSON", () => {
    expect(
      decodeCursor(Buffer.from("plain text").toString("base64url")),
    ).toBeNull();
  });

  it("rejects JSON of the wrong shape", () => {
    const raw = Buffer.from(JSON.stringify({ id: "x" })).toString("base64url");
    expect(decodeCursor(raw)).toBeNull();
  });

  it("rejects an unparseable createdAt", () => {
    const raw = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "x" }),
    ).toString("base64url");
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe("clampLimit", () => {
  it("returns the default when absent", () => {
    expect(clampLimit(undefined, { default: 50 })).toBe(50);
  });

  it("passes a valid limit through", () => {
    expect(clampLimit("5", { default: 50 })).toBe(5);
  });

  it("clamps above the server ceiling", () => {
    expect(clampLimit("9999", { default: 50 })).toBe(MAX_PAGE_LIMIT);
  });

  it("rejects non-integers and non-positives", () => {
    expect(clampLimit("nope", { default: 50 })).toBeNull();
    expect(clampLimit("1.5", { default: 50 })).toBeNull();
    expect(clampLimit("0", { default: 50 })).toBeNull();
    expect(clampLimit("-3", { default: 50 })).toBeNull();
  });
});

describe("takePage", () => {
  const rows = [
    { createdAt: new Date("2026-07-10T09:00:00.000Z"), id: "c" },
    { createdAt: new Date("2026-07-10T08:00:00.000Z"), id: "b" },
    { createdAt: new Date("2026-07-10T07:00:00.000Z"), id: "a" },
  ];

  it("returns all rows with no cursor when at or under the limit", () => {
    expect(takePage(rows, 3)).toEqual({ items: rows });
  });

  it("drops the sentinel row and derives nextCursor from the last kept row", () => {
    const page = takePage(rows, 2);
    expect(page.items).toEqual(rows.slice(0, 2));
    expect(page.nextCursor).toBe(encodeCursor(rows[1]!));
  });
});
