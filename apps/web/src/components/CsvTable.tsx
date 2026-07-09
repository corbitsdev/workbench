import { capCsvRows, parseCsv, parsedCsvIsTabular } from "@workbench/artifact";
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

// Renders CSV text as a table. Parses defensively: a ragged/malformed file (any
// row whose column count differs from the header) is not forced into a grid —
// it degrades to the raw text so cells never shift columns. Large files are
// capped so the non-virtualized table never freezes the panel, with an honest
// "showing N of M" indicator.
export function CsvTable({ csvText }: { csvText: string }) {
  const parsed = parseCsv(csvText);

  if (!parsedCsvIsTabular(parsed)) {
    return (
      <pre className="overflow-x-auto rounded border border-border bg-surface-2 p-3 text-xs text-text-2">
        {csvText}
      </pre>
    );
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
