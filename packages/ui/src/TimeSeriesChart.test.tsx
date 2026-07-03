/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { TimeSeriesChart, type TimeSeries } from "./TimeSeriesChart";

afterEach(cleanup);

const SERIES: TimeSeries[] = [
  {
    key: "turns",
    name: "Turns",
    points: [
      { label: "2026-06-01", value: 2 },
      { label: "2026-06-02", value: 8 },
      { label: "2026-06-03", value: 5 },
    ],
  },
];

describe("TimeSeriesChart", () => {
  it("renders a path per series and an accessible summary", () => {
    render(<TimeSeriesChart series={SERIES} label="Turns per day" />);
    const chart = screen.getByTestId("time-series-chart");
    expect(chart.querySelectorAll("path").length).toBeGreaterThan(0);
    const svg = chart.querySelector("svg");
    expect(svg?.getAttribute("aria-label")).toContain("Peak 8");
  });

  it("mirrors every point in a visually-hidden table fallback", () => {
    render(<TimeSeriesChart series={SERIES} label="Turns per day" />);
    const table = screen.getByTestId("time-series-table");
    // header row + 3 data rows
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(table.textContent).toContain("2026-06-02");
  });

  it("shows a legend only when there are multiple series", () => {
    const { rerender } = render(
      <TimeSeriesChart series={SERIES} label="one" />,
    );
    expect(screen.queryByTestId("time-series-legend")).toBeNull();
    rerender(
      <TimeSeriesChart
        series={[...SERIES, { ...SERIES[0], key: "tools", name: "Tools" }]}
        label="two"
      />,
    );
    expect(screen.getAllByTestId("time-series-legend").length).toBe(2);
  });

  it("renders an empty state when every value is zero", () => {
    render(
      <TimeSeriesChart
        label="empty"
        series={[
          {
            key: "z",
            name: "Zero",
            points: [
              { label: "a", value: 0 },
              { label: "b", value: 0 },
            ],
          },
        ]}
      />,
    );
    screen.getByTestId("time-series-empty");
    expect(screen.queryByTestId("time-series-chart")).toBeNull();
  });
});
