import {
  capCsvRows,
  CSV_MAX_PREVIEW_BYTES,
  parseCsv,
  parsedCsvIsTabular,
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
// non-CSV or ragged file into a misleading grid. Shared by the ragged-parse
// branch here and the wrong-content-type branch in the uploaded-CSV viewer.
export function CsvRawText({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded border border-border bg-surface-2 p-3 text-xs text-text-2">
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

// Renders CSV text as a table. Guards before parsing: an oversized string is
// refused up front (parseCsv would otherwise walk the whole thing and the DOM
// would hold it, hanging the tab). Then parses defensively — a ragged/malformed
// file (any row whose column count differs from the header) degrades to raw text
// so cells never shift columns. Large-but-allowed files are row-capped so the
// non-virtualized table never freezes, with an honest "showing N of M" indicator.
export function CsvTable({ csvText }: { csvText: string }) {
  if (csvText.length > CSV_MAX_PREVIEW_BYTES) {
    return <CsvTooLarge />;
  }

  const parsed = parseCsv(csvText);

  if (!parsedCsvIsTabular(parsed)) {
    return <CsvRawText text={csvText} />;
  }

  const capped = capCsvRows(parsed);
  const columns: DataTableColumn<CsvRow>[] = parsed.headers.map(
    (header, colIndex) => ({
      key: String(colIndex),
      header,
      render: (row: CsvRow) => row.cells[colIndex] ?? "",
    }),
  );
  const rows: CsvRow[] = capped.rows.map((cells, index) => ({ index, cells }));

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded border border-border">
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => String(row.index)}
          caption="CSV contents"
        />
      </div>
      {capped.truncated ? (
        <p className="text-xs text-text-3">
          Showing {capped.rows.length.toLocaleString()} of{" "}
          {capped.total.toLocaleString()} rows — download for the full file.
        </p>
      ) : null}
    </div>
  );
}
