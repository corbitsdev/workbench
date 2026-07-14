/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { StatGrid, StatGridItem } from "./StatGrid";

afterEach(cleanup);

describe("StatGrid", () => {
  it("renders stat tiles with labels and values", () => {
    render(
      <StatGrid columns={2}>
        <StatGridItem label="Runs" value="12" sub="in range" />
        <StatGridItem label="Errors" value="1" danger />
      </StatGrid>,
    );
    screen.getByTestId("stat-grid");
    expect(screen.getAllByTestId("stat-grid-item")).toHaveLength(2);
    screen.getByText("Runs");
    screen.getByText("12");
    screen.getByText("in range");
  });

  it("embeds a sparkline from values", () => {
    render(
      <StatGrid>
        <StatGridItem
          label="Turns"
          value="40"
          sparklineValues={[1, 4, 2, 8]}
          sparklineLabel="Turn trend"
        />
      </StatGrid>,
    );
    screen.getByTestId("stat-sparkline");
  });

  it("accepts a custom sparkline slot", () => {
    render(
      <StatGrid>
        <StatGridItem
          label="Custom"
          value="0"
          sparkline={<div data-testid="custom-spark">slot</div>}
          sparklineValues={[1, 2, 3]}
        />
      </StatGrid>,
    );
    screen.getByTestId("custom-spark");
    expect(screen.queryByTestId("stat-sparkline")).toBeNull();
  });
});