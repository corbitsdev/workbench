/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { DashboardSection } from "./DashboardSection";

afterEach(cleanup);

describe("DashboardSection", () => {
  it("renders title and children", () => {
    render(
      <DashboardSection title="Engagement">
        <p data-testid="body">Body</p>
      </DashboardSection>,
    );
    screen.getByRole("heading", { name: "Engagement" });
    screen.getByTestId("body");
    expect(screen.getByTestId("dashboard-section").dataset.variant).toBe(
      "plain",
    );
  });

  it("renders description and action slots", () => {
    render(
      <DashboardSection
        title="Costs"
        description="Token spend in range"
        action={<button type="button">Export</button>}
      >
        <span>Charts</span>
      </DashboardSection>,
    );
    screen.getByText("Token spend in range");
    screen.getByRole("button", { name: "Export" });
  });

  it("applies highlighted shell variant", () => {
    render(
      <DashboardSection title="This range" variant="highlighted">
        <span>Grid</span>
      </DashboardSection>,
    );
    const section = screen.getByTestId("dashboard-section");
    expect(section.dataset.variant).toBe("highlighted");
    expect(section.className).toContain("from-surface-2");
  });
});