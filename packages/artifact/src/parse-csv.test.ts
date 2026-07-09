import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  CSV_TABLE_ROW_CAP,
  ParsedCsvSchema,
  capCsvRows,
  parseCsv,
  parsedCsvIsTabular,
} from "./parse-csv";

describe("parseCsv", () => {
  test("handles quoted commas, embedded newlines, and escaped quotes", () => {
    const csv = 'name,note\n"Doe, Jane","line1\nline2"\n"He said ""hi""",ok\n';
    expect(parseCsv(csv)).toEqual({
      headers: ["name", "note"],
      rows: [
        ["Doe, Jane", "line1\nline2"],
        ['He said "hi"', "ok"],
      ],
    });
  });

  test("tolerates a missing trailing newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual({
      headers: ["a", "b"],
      rows: [["1", "2"]],
    });
  });

  test("strips a leading UTF-8 BOM from the first header", () => {
    expect(parseCsv("﻿a,b\n1,2\n")).toEqual({
      headers: ["a", "b"],
      rows: [["1", "2"]],
    });
  });

  test("treats CRLF line endings as row breaks", () => {
    expect(parseCsv("a,b\r\n1,2\r\n3,4\r\n")).toEqual({
      headers: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  test("preserves a trailing empty field", () => {
    expect(parseCsv("a,b,c\n1,,3\n")).toEqual({
      headers: ["a", "b", "c"],
      rows: [["1", "", "3"]],
    });
  });

  test("parses a single-column file with no delimiters", () => {
    expect(parseCsv("name\nAlice\nBob\n")).toEqual({
      headers: ["name"],
      rows: [["Alice"], ["Bob"]],
    });
  });

  test("keeps a comma inside a quoted field as data, not a delimiter", () => {
    expect(parseCsv('a,b\n"x,y",z\n')).toEqual({
      headers: ["a", "b"],
      rows: [["x,y", "z"]],
    });
  });

  test("returns empty headers and rows for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });

  test("keeps a header-only file as a tabular shape with zero rows", () => {
    expect(parseCsv("a,b,c\n")).toEqual({ headers: ["a", "b", "c"], rows: [] });
  });

  test("skips a trailing blank line rather than emitting a ragged empty row", () => {
    expect(parseCsv("a,b\n1,2\n\n")).toEqual({
      headers: ["a", "b"],
      rows: [["1", "2"]],
    });
  });

  test("skips interior blank lines between records", () => {
    expect(parseCsv("a,b\n1,2\n\n3,4\n")).toEqual({
      headers: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  test("treats lone CR (classic-Mac) line endings as row breaks", () => {
    expect(parseCsv("a,b\r1,2\r3,4\r")).toEqual({
      headers: ["a", "b"],
      rows: [
        ["1", "2"],
        ["3", "4"],
      ],
    });
  });

  test("preserves an explicit quoted-empty-field row (not dropped as blank)", () => {
    expect(parseCsv('name\n""\nx\n')).toEqual({
      headers: ["name"],
      rows: [[""], ["x"]],
    });
  });

  test("distinguishes a truly blank line from a quoted-empty row", () => {
    // The blank line between the two records is skipped; the quoted-empty row is kept.
    expect(parseCsv('name\nx\n\n""\n')).toEqual({
      headers: ["name"],
      rows: [["x"], [""]],
    });
  });
});

describe("parsedCsvIsTabular", () => {
  test("is true when every row matches the header column count", () => {
    expect(parsedCsvIsTabular(parseCsv("a,b\n1,2\n3,4\n"))).toBe(true);
  });

  test("is true for a header row with no body rows", () => {
    expect(parsedCsvIsTabular(parseCsv("a,b,c\n"))).toBe(true);
  });

  test("is false when a row is ragged (fewer columns than the header)", () => {
    expect(parsedCsvIsTabular(parseCsv("a,b,c\n1,2\n"))).toBe(false);
  });

  test("is false when a row has more columns than the header", () => {
    expect(parsedCsvIsTabular(parseCsv("a,b\n1,2,3\n"))).toBe(false);
  });

  test("is false when there is no header", () => {
    expect(parsedCsvIsTabular({ headers: [], rows: [] })).toBe(false);
  });

  test("stays tabular when the file has blank separator lines", () => {
    expect(parsedCsvIsTabular(parseCsv("a,b\n1,2\n\n3,4\n"))).toBe(true);
  });
});

describe("ParsedCsvSchema", () => {
  test("accepts a well-formed tabular parse", () => {
    const parsed = ParsedCsvSchema(parseCsv("a,b\n1,2\n3,4\n"));
    expect(parsed instanceof type.errors).toBe(false);
  });

  test("accepts a header-only parse with zero rows", () => {
    expect(ParsedCsvSchema(parseCsv("a,b,c\n")) instanceof type.errors).toBe(
      false,
    );
  });

  test("rejects an empty parse with no columns", () => {
    const result = ParsedCsvSchema({ headers: [], rows: [] });
    expect(result instanceof type.errors).toBe(true);
  });

  test("rejects a ragged parse whose rows do not match the header width", () => {
    const result = ParsedCsvSchema({ headers: ["a", "b"], rows: [["1"]] });
    expect(result instanceof type.errors).toBe(true);
  });

  test("rejects a structurally wrong value (rows not string[][])", () => {
    const result = ParsedCsvSchema({ headers: ["a"], rows: [[1]] });
    expect(result instanceof type.errors).toBe(true);
  });
});

describe("capCsvRows", () => {
  test("returns all rows untruncated when under the cap", () => {
    const parsed = { headers: ["a"], rows: [["1"], ["2"]] };
    expect(capCsvRows(parsed, 5)).toEqual({
      rows: [["1"], ["2"]],
      total: 2,
      truncated: false,
    });
  });

  test("truncates to the cap and reports the true total when over", () => {
    const parsed = {
      headers: ["a"],
      rows: [["1"], ["2"], ["3"], ["4"]],
    };
    const capped = capCsvRows(parsed, 2);
    expect(capped.rows).toEqual([["1"], ["2"]]);
    expect(capped.total).toBe(4);
    expect(capped.truncated).toBe(true);
  });

  test("defaults to the CSV_TABLE_ROW_CAP constant", () => {
    const rows = Array.from({ length: CSV_TABLE_ROW_CAP + 3 }, (_, i) => [
      String(i),
    ]);
    const capped = capCsvRows({ headers: ["a"], rows });
    expect(capped.rows).toHaveLength(CSV_TABLE_ROW_CAP);
    expect(capped.total).toBe(CSV_TABLE_ROW_CAP + 3);
    expect(capped.truncated).toBe(true);
  });
});
