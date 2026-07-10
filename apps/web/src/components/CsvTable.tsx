import { useMemo } from "react";
import {
  capCsvRows,
  CSV_COLUMN_CAP,
  CSV_MAX_PREVIEW_BYTES,
  parseCsv,
  parsedCsvIsTabular,
  utf8ByteLength,
} from "@workbench/artifact";
import { DataTable, type DataTableColumn } from "@workbench/ui";

// One parsed body row, carrying its source index. The index — not the cell
// content — is the stable React key: CSV rows are frequently duplicated, so
// keying on content would collide. Columns are likewise keyed by index because
// headers can be empty or duplicated ("", two "Name" columns) and a
// header-string key would silently drop a column.
interface CsvRow {
  index: number;
  cells: string[];
}

// The honest fallback surface: show the source text verbatim rather than force a
// ragged/non-tabular file into a misleading grid. Height-capped with its own
// scroll so a multi-thousand-line file can't render as one giant <pre> and
// re-open the DOM-freeze the tabular path guards against.
export function CsvRawText({ text }: { text: string }) {
  return (
    <pre className="max-h-96 overflow-auto rounded border border-border bg-surface-2 p-3 text-xs text-text-2">
      {text}
    </pre>
  );
}

// Shown when a file is too large to parse and render inline. The parent surfaces
// the download link, so this only has to explain why the table is absent.
export function CsvTooLarge() {
  return (
    <div className="rounded border border-border bg-surface-2/40 px-4 py-6 text-center text-sm text-text-3">
      This file is too large to preview here — use Download for the full file.
    </div>
  );
}

type CsvView =
  | { kind: "too-large" }
  | { kind: "raw" }
  | { kind: "table"; headers: string[] };

// Renders CSV text as a table. Guards before parsing: an oversized string (true
// UTF-8 bytes) is refused up front — parseCsv would otherwise walk the whole
// thing and the DOM would hold it, hanging the tab. Then parses defensively — a
// ragged/malformed file degrades to raw text so cells never shift columns. The
// parse + validation is memoized on the text so a parent re-render does not
// re-walk the whole row set. Large-but-allowed files are row- and column-capped
// so the non-virtualized table never freezes, with an honest "showing N of M"
// indicator.
export function CsvTable({ csvText }: { csvText: string }) {
  const parsed = useMemo(() => {
    if (utf8ByteLength(csvText) > CSV_MAX_PREVIEW_BYTES) return null;
    return parseCsv(csvText);
  }, [csvText]);

  const view: CsvView = useMemo(() => {
    if (parsed === null) return { kind: "too-large" };
    if (!parsedCsvIsTabular(parsed)) return { kind: "raw" };
    return { kind: "table", headers: parsed.headers };
  }, [parsed]);

  if (view.kind === "too-large") return <CsvTooLarge />;
  if (view.kind === "raw" || parsed === null)
    return <CsvRawText text={csvText} />;

  const totalColumns = view.headers.length;
  const columnsTruncated = totalColumns > CSV_COLUMN_CAP;
  const shownHeaders = columnsTruncated
    ? view.headers.slice(0, CSV_COLUMN_CAP)
    : view.headers;

  const capped = capCsvRows(parsed);
  const columns: DataTableColumn<CsvRow>[] = shownHeaders.map(
    (header, colIndex) => ({
      key: String(colIndex),
      header,
      render: (row: CsvRow) => row.cells[colIndex] ?? "",
    }),
  );
  const rows: CsvRow[] = capped.rows.map((cells, index) => ({ index, cells }));

  const notes: string[] = [];
  if (capped.truncated) {
    notes.push(
      `${capped.rows.length.toLocaleString()} of ${capped.total.toLocaleString()} rows`,
    );
  }
  if (columnsTruncated) {
    notes.push(
      `${CSV_COLUMN_CAP.toLocaleString()} of ${totalColumns.toLocaleString()} columns`,
    );
  }

  return (
    <div className="space-y-2">
      <div className="max-h-[32rem] overflow-auto rounded border border-border">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => String(row.index)}
          caption="CSV contents"
        />
      </div>
      {notes.length > 0 ? (
        <p className="text-xs text-text-3">
          Showing {notes.join(" and ")} — download for the full file.
        </p>
      ) : null}
    </div>
  );
}
