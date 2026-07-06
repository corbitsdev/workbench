import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DataTable, type DataTableColumn } from "./DataTable";

afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  city: string;
}

const rows: Row[] = [
  { id: "1", name: "Ada", city: "London" },
  { id: "2", name: "Grace", city: "New York" },
];

const columns: DataTableColumn<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name },
  { key: "city", header: "City", render: (r) => r.city },
];

function renderInteractive(onRowClick: (r: Row) => void) {
  return render(
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      onRowClick={onRowClick}
    />,
  );
}

function renderStatic() {
  return render(
    <DataTable columns={columns} rows={rows} getRowKey={(r) => r.id} />,
  );
}

describe("DataTable interactive rows", () => {
  it("fires onRowClick from a click ANYWHERE in the row, not just cell 0", () => {
    const onRowClick = mock((_r: Row) => {});
    renderInteractive(onRowClick);
    // The city cell is not the first column — clicking it must still activate.
    fireEvent.click(screen.getByText("New York"));
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]?.[0]?.id).toBe("2");
  });

  it("marks interactive rows as button role with hover + pointer affordance", () => {
    renderInteractive(() => {});
    const row = screen.getByText("Ada").closest("tr") as HTMLElement;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    expect(row.className).toContain("cursor-pointer");
    expect(row.className).toContain("hover:bg-surface-2");
  });

  it("activates on Enter for keyboard users", () => {
    const onRowClick = mock((_r: Row) => {});
    renderInteractive(onRowClick);
    const row = screen.getByText("Grace").closest("tr") as HTMLElement;
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(onRowClick.mock.calls[0]?.[0]?.id).toBe("2");
  });

  it("stays non-interactive (no button role / cursor) without onRowClick", () => {
    renderStatic();
    const row = screen.getByText("Ada").closest("tr") as HTMLElement;
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBeNull();
    expect(row.className).not.toContain("cursor-pointer");
  });
});
