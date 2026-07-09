// Read side of the RFC 4180 CSV conventions the app already writes (see the
// hub's insights-csv-export escapeField: quote-wrap on `",\n\r`, double-up
// embedded quotes). Hand-rolled rather than adding a dependency — the write side
// is a ~15-line escaper and this is its inverse.

import { type } from "arktype";

// Canonical shape of a parsed CSV, and the boundary gate for rendering it as a
// table. The narrow is the single source of truth for "is this safe to grid?":
// it rejects a headerless parse (nothing to render) and any ragged parse (a row
// whose column count differs from the header — the classic sign of a mis-parse
// or a non-CSV file routed here). A rejected result routes deterministically to
// the raw-text fallback rather than relying on parseCsv "never throwing".
export const ParsedCsvSchema = type({
  headers: "string[]",
  rows: "string[][]",
}).narrow((csv, ctx) => {
  if (csv.headers.length === 0) {
    return ctx.reject("a CSV table needs at least one column");
  }
  const width = csv.headers.length;
  if (!csv.rows.every((row) => row.length === width)) {
    return ctx.reject("every CSV row must match the header column count");
  }
  return true;
});
export type ParsedCsv = typeof ParsedCsvSchema.infer;

// Default cap on rows rendered as a live table. DataTable has no virtualization,
// so an unbounded export would freeze the panel; past this we truncate and show a
// "download for full file" indicator. Named so it is trivially tunable.
export const CSV_TABLE_ROW_CAP = 500;

// Hard ceiling, in bytes/characters, on CSV text we will parse and preview. A
// pathological upload would make parseCsv walk (and the DOM hold) an unbounded
// string, hanging the tab; past this the viewer shows a "too large to preview —
// download instead" state and never parses. 2 MB comfortably covers real GTM
// exports (a 500-row display cap is reached long before this) while a 2 MB string
// parses in well under a frame.
export const CSV_MAX_PREVIEW_BYTES = 2_000_000;

// RFC 4180 reader. Single pass. Two bits of state: whether we are inside a quoted
// field, and whether the current record has accumulated any content (`started`).
// `started` lets a truly blank line be skipped while a line whose only content is
// an explicit quoted-empty field (`""`) is still emitted — a lone `inQuotes` flag
// cannot tell those apart once the closing quote resets it. Never throws — a
// malformed file yields whatever parsed so the caller can degrade to raw text.
export function parseCsv(input: string): ParsedCsv {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // strip BOM
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let started = false; // has the current record seen any field content or delimiter?
  let i = 0;

  function pushRow(): void {
    row.push(field);
    rows.push(row);
    field = "";
    row = [];
    started = false;
  }

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        } // escaped quote
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true; // an explicit (possibly empty) quoted field
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      started = true;
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") {
        i++;
        continue;
      } // CRLF: let the \n branch break the row
      // Lone CR (classic-Mac): a blank line is skipped, a real record breaks here.
      if (!started) {
        i++;
        continue;
      }
      pushRow();
      i++;
      continue;
    }
    if (ch === "\n") {
      // A blank line is not a record — skip it rather than emitting a spurious
      // single-empty-field row that would make an otherwise-tabular file ragged.
      if (!started) {
        i++;
        continue;
      }
      pushRow();
      i++;
      continue;
    }
    field += ch;
    started = true;
    i++;
  }
  if (started || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row); // flush trailing (no final newline)
  }
  const [headers = [], ...body] = rows;
  return { headers, rows: body };
}

// A parsed CSV is safe to render as a table when ParsedCsvSchema accepts it: a
// header row present and every body row matching the header's column count (zero
// body rows is fine — an empty table with headers). The schema is the gate; this
// is the boolean convenience wrapper the viewer reads.
export function parsedCsvIsTabular(parsed: ParsedCsv): boolean {
  return !(ParsedCsvSchema(parsed) instanceof type.errors);
}

export type CappedCsv = {
  rows: string[][];
  total: number;
  truncated: boolean;
};

// Bound the rows handed to a non-virtualized table. Returns the visible slice,
// the true total, and whether truncation occurred so the viewer can show an
// honest "showing N of M" indicator.
export function capCsvRows(
  parsed: ParsedCsv,
  cap: number = CSV_TABLE_ROW_CAP,
): CappedCsv {
  const total = parsed.rows.length;
  if (total <= cap) return { rows: parsed.rows, total, truncated: false };
  return { rows: parsed.rows.slice(0, cap), total, truncated: true };
}
