// Read side of the RFC 4180 CSV conventions the app already writes (see the
// hub's insights-csv-export escapeField: quote-wrap on `",\n\r`, double-up
// embedded quotes). Hand-rolled rather than adding a dependency — the write side
// is a ~15-line escaper and this is its inverse.

export type ParsedCsv = { headers: string[]; rows: string[][] };

// Default cap on rows rendered as a live table. DataTable has no virtualization,
// so an unbounded export would freeze the panel; past this we truncate and show a
// "download for full file" indicator. Named so it is trivially tunable.
export const CSV_TABLE_ROW_CAP = 500;

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

// A parsed CSV is safe to render as a table when it has a header row and every
// body row has exactly the header's column count. A file with zero body rows is
// tabular (an empty table with headers). Any ragged row — the classic sign of a
// mis-parse or a non-CSV file that happened to be routed here — drops the whole
// render to a raw-text fallback so cells never silently shift columns.
export function parsedCsvIsTabular(parsed: ParsedCsv): boolean {
  if (parsed.headers.length === 0) return false;
  return parsed.rows.every((row) => row.length === parsed.headers.length);
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
