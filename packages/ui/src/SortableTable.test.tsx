/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SortableTable, type SortableColumn } from "./SortableTable";

afterEach(cleanup);

type Person = { id: string; name: string; tokens: number };

const PEOPLE: Person[] = [
  { id: "a", name: "Ada", tokens: 10 },
  { id: "b", name: "Bea", tokens: 40 },
  { id: "c", name: "Cy", tokens: 20 },
  { id: "d", name: "Dot", tokens: 5 },
  { id: "e", name: "Eve", tokens: 30 },
];

const COLUMNS: SortableColumn<Person>[] = [
  {
    key: "name",
    header: "Person",
    render: (r) => <a href={`/insights/users/${r.id}`}>{r.name}</a>,
    sortValue: (r) => r.name,
  },
  {
    key: "tokens",
    header: "Tokens",
    render: (r) => r.tokens,
    sortValue: (r) => r.tokens,
    align: "right",
  },
];

function renderTable(pageSize = 0) {
  return render(
    <SortableTable
      columns={COLUMNS}
      rows={PEOPLE}
      getRowKey={(r) => r.id}
      caption="Usage by person"
      initialSort={{ key: "tokens", dir: "desc" }}
      pageSize={pageSize}
    />,
  );
}

function rowNames(): string[] {
  return screen
    .getAllByTestId("sortable-row")
    .map((row) => row.querySelector("a")?.textContent ?? "");
}

describe("SortableTable", () => {
  it("applies the initial sort (tokens desc)", () => {
    renderTable();
    expect(rowNames()).toEqual(["Bea", "Eve", "Cy", "Ada", "Dot"]);
  });

  it("toggles direction when the active header is clicked", () => {
    renderTable();
    const tokensHeader = screen
      .getAllByTestId("sortable-header")
      .find((b) => b.getAttribute("data-col") === "tokens")!;
    fireEvent.click(tokensHeader);
    expect(rowNames()[0]).toBe("Dot"); // now ascending -> smallest first
  });

  it("sorts by a different column and marks aria-sort", () => {
    renderTable();
    const nameHeader = screen
      .getAllByTestId("sortable-header")
      .find((b) => b.getAttribute("data-col") === "name")!;
    fireEvent.click(nameHeader);
    expect(rowNames()).toEqual(["Eve", "Dot", "Cy", "Bea", "Ada"]);
    const th = nameHeader.closest("th");
    expect(th?.getAttribute("aria-sort")).toBe("descending");
  });

  it("renders row-level deep links inside cells", () => {
    renderTable();
    const link = screen.getAllByRole("link")[0];
    expect(link!.getAttribute("href")).toContain("/insights/users/");
  });

  it("paginates and clamps the page across a sort that shrinks the view", () => {
    renderTable(2);
    expect(screen.getAllByTestId("sortable-row")).toHaveLength(2);
    expect(screen.getByTestId("pager-range").textContent).toContain(
      "Showing 1–2 of 5",
    );
    fireEvent.click(screen.getByTestId("pager-next"));
    expect(screen.getByTestId("pager-range").textContent).toContain(
      "Showing 3–4 of 5",
    );
  });

  it("shows an empty state with no rows", () => {
    render(
      <SortableTable
        columns={COLUMNS}
        rows={[]}
        getRowKey={(r) => r.id}
        caption="empty"
        emptyMessage="No people yet"
      />,
    );
    screen.getByText("No people yet");
  });
});
