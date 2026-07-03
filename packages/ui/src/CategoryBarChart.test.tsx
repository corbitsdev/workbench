/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { CategoryBarChart } from "./CategoryBarChart";

afterEach(cleanup);

const DATA = [
  { label: "Deck", value: 40 },
  { label: "Brief", value: 20 },
  { label: "Landing", value: 10 },
];

describe("CategoryBarChart", () => {
  it("renders one bar per datum with its value", () => {
    render(<CategoryBarChart data={DATA} label="Runs by kind" />);
    const bars = screen.getAllByTestId("category-bar");
    expect(bars).toHaveLength(3);
    expect(bars[0].getAttribute("data-value")).toBe("40");
  });

  it("scales the widest bar to full width", () => {
    render(<CategoryBarChart data={DATA} label="Runs by kind" />);
    const fills = screen.getAllByTestId("category-bar-fill");
    expect(fills[0].style.width).toBe("100%");
    expect(fills[2].style.width).toBe("25%");
  });

  it("caps the number of bars via maxBars", () => {
    render(<CategoryBarChart data={DATA} label="x" maxBars={2} />);
    expect(screen.getAllByTestId("category-bar")).toHaveLength(2);
  });

  it("provides a table fallback for the ranking", () => {
    render(<CategoryBarChart data={DATA} label="Runs by kind" />);
    const table = screen.getByTestId("category-bar-table");
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  it("shows an empty state with no data", () => {
    render(<CategoryBarChart data={[]} label="x" />);
    screen.getByTestId("category-bar-empty");
    expect(screen.queryByTestId("category-bar-chart")).toBeNull();
  });
});
