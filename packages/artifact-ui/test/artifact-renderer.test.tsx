// The sheet renderer used to hand-roll its own uncapped CSV parser and a raw
// <table> — an artifact with more rows/columns than react-ui's CsvTable caps
// (CSV_ROW_CAP / CSV_COLUMN_CAP) would render every row into the DOM and
// could lock the tab. This proves the cutover to CsvTable actually caps
// output instead of just moving the same unbounded render behind a new name.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CSV_ROW_CAP } from "@corbits/react-ui";

import { ArtifactRenderer } from "../src/artifact-renderer";

function oversizedCsv(rowCount: number): string {
  const header = "id,name\n";
  const rows = Array.from(
    { length: rowCount },
    (_, index) => `${index},row-${index}`,
  ).join("\n");
  return header + rows;
}

describe("ArtifactRenderer sheet cutover", () => {
  test("caps an oversized CSV's rendered rows instead of rendering all of them", () => {
    const rowCount = CSV_ROW_CAP + 250;
    const content = oversizedCsv(rowCount);

    const markup = renderToStaticMarkup(
      <ArtifactRenderer
        rendererKind="sheet"
        title="Big sheet"
        content={content}
      />,
    );

    const renderedDataRows = markup.match(/row-\d+/g)?.length ?? 0;
    expect(renderedDataRows).toBeLessThanOrEqual(CSV_ROW_CAP);
    expect(renderedDataRows).toBeGreaterThan(0);
    expect(renderedDataRows).toBeLessThan(rowCount);
  });

  test("renders a normal CSV as a table with all its rows", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer
        rendererKind="sheet"
        title="Small sheet"
        content={"id,name\n1,Ada\n2,Grace"}
      />,
    );
    expect(markup).toContain("Ada");
    expect(markup).toContain("Grace");
  });

  test("renders the empty state for an empty sheet", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer rendererKind="sheet" title="Empty sheet" content="" />,
    );
    expect(markup).toContain("This sheet has no rows yet.");
  });
});

describe("ArtifactRenderer contentUnavailable — stored-but-unreadable file", () => {
  test("doc renderer says the file couldn't be read, not that it's empty", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer
        rendererKind="doc"
        title="notes.docx"
        content=""
        contentUnavailable
      />,
    );
    expect(markup).toContain(
      "We couldn&#x27;t read this file&#x27;s contents for preview.",
    );
    expect(markup).not.toContain("This document has no content yet.");
  });

  test("sheet renderer says the file couldn't be read, not that it's empty", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer
        rendererKind="sheet"
        title="budget.xlsx"
        content=""
        contentUnavailable
      />,
    );
    expect(markup).toContain(
      "We couldn&#x27;t read this file&#x27;s contents for preview.",
    );
    expect(markup).not.toContain("This sheet has no rows yet.");
  });

  test("pdf renderer says the file couldn't be read, not that no text is stored", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer
        rendererKind="pdf"
        title="contract.pdf"
        content=""
        contentUnavailable
      />,
    );
    expect(markup).toContain(
      "We couldn&#x27;t read this file&#x27;s contents for preview.",
    );
    expect(markup).not.toContain("No extracted text is stored");
  });

  test("a genuinely empty doc still reads as empty, not unreadable", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer rendererKind="doc" title="Untitled" content="" />,
    );
    expect(markup).toContain("This document has no content yet.");
  });
});

describe("ArtifactRenderer html preview", () => {
  test("renders a sandboxed iframe pointed at the preview route", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer
        rendererKind="html"
        title="Landing page"
        content=""
        previewSrc="/api/tenants/t1/artifacts/a1/preview"
      />,
    );
    expect(markup).toContain("<iframe");
    expect(markup).toContain('sandbox="allow-scripts"');
    expect(markup).toContain('src="/api/tenants/t1/artifacts/a1/preview"');
  });

  test("falls back to an unsupported message with no previewSrc", () => {
    const markup = renderToStaticMarkup(
      <ArtifactRenderer rendererKind="html" title="Landing page" content="" />,
    );
    expect(markup).not.toContain("<iframe");
    expect(markup).toContain(
      "No sandboxed preview is available for this HTML artifact yet.",
    );
  });
});
