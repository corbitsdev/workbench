/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { CSV_MAX_PREVIEW_BYTES, CSV_TABLE_ROW_CAP } from "@workbench/artifact";
import { CsvTable } from "./CsvTable";

afterEach(() => {
  cleanup();
});

describe("CsvTable", () => {
  it("lands nasty CSV values in the right cells (quoted comma, escaped quote, embedded newline, CRLF)", () => {
    const csv =
      'name,note\r\n"Doe, Jane","line1\nline2"\r\n"He said ""hi""",ok\r\n';
    render(React.createElement(CsvTable, { csvText: csv }));

    const table = screen.getByRole("table");
    // Header cells preserve the exact header text.
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.map((h) => h.textContent)).toEqual(["name", "note"]);

    // A quoted comma stays one cell, not two columns.
    within(table).getByText("Doe, Jane");
    // Escaped "" collapses to a single quote.
    within(table).getByText('He said "hi"');
    // The embedded newline survives inside the cell.
    within(table).getByText((content) => content.includes("line1"));
  });

  it("renders a header-only CSV as an empty table, not a raw dump", () => {
    render(React.createElement(CsvTable, { csvText: "a,b,c\n" }));
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["a", "b", "c"]);
    expect(screen.queryByRole("row", { name: /1/ })).toBeNull();
  });

  it("degrades a ragged file to raw text instead of a shifted table", () => {
    const csv = "a,b,c\n1,2\n";
    const { container } = render(
      React.createElement(CsvTable, { csvText: csv }),
    );
    expect(screen.queryByRole("table")).toBeNull();
    const pre = container.querySelector("pre");
    if (pre === null) throw new Error("expected a raw-text fallback");
    expect(pre.textContent).toBe(csv);
  });

  it("renders a table for a CSV with a trailing blank line, not a raw dump", () => {
    render(React.createElement(CsvTable, { csvText: "a,b\n1,2\n\n" }));
    const table = screen.getByRole("table");
    within(table).getByText("1");
    within(table).getByText("2");
  });

  it("caps large files and shows an honest showing-N-of-M indicator", () => {
    const total = CSV_TABLE_ROW_CAP + 25;
    const body = Array.from({ length: total }, (_, i) => `${i},row${i}`).join(
      "\n",
    );
    const csv = `id,label\n${body}\n`;
    render(React.createElement(CsvTable, { csvText: csv }));

    const table = screen.getByRole("table");
    // Header row + capped body rows only.
    expect(within(table).getAllByRole("row")).toHaveLength(
      CSV_TABLE_ROW_CAP + 1,
    );
    screen.getByText(
      new RegExp(
        `showing ${CSV_TABLE_ROW_CAP.toLocaleString()} of ${total.toLocaleString()} rows`,
        "i",
      ),
    );
  });

  it("refuses to parse an oversized file and shows a too-large notice", () => {
    // One header line plus a body larger than the byte ceiling. If it parsed,
    // a table would render; the guard must short-circuit before parseCsv runs.
    const huge = "a,b\n" + "x,y\n".repeat(CSV_MAX_PREVIEW_BYTES / 4 + 10);
    render(React.createElement(CsvTable, { csvText: huge }));
    expect(screen.queryByRole("table")).toBeNull();
    screen.getByText(/too large to preview/i);
  });

  it("shows no truncation indicator when the file fits under the cap", () => {
    render(React.createElement(CsvTable, { csvText: "a,b\n1,2\n3,4\n" }));
    screen.getByRole("table");
    expect(screen.queryByText(/showing .* of .* rows/i)).toBeNull();
  });
});
