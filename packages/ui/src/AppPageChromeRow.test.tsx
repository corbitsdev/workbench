import "./test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { AppPageChromeRow } from "./AppPageChromeRow";

afterEach(cleanup);

describe("AppPageChromeRow", () => {
  it("renders the title as a level-1 heading", () => {
    render(<AppPageChromeRow title="Skills" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Skills" }),
    ).toBeTruthy();
  });

  it("renders a count badge only when count is provided", () => {
    const { rerender } = render(<AppPageChromeRow title="Tools" count={7} />);
    expect(screen.getByText("7 items")).toBeTruthy();

    rerender(<AppPageChromeRow title="Tools" />);
    expect(screen.queryByText(/items/)).toBeNull();
  });

  it("renders a string count verbatim (e.g. a '+' suffix for an unknown total)", () => {
    render(<AppPageChromeRow title="Artifacts" count="12+" />);
    expect(screen.getByText("12+ items")).toBeTruthy();
  });

  it("wraps trailing controls for narrow top bars", () => {
    render(<AppPageChromeRow title="Skills" />);
    const heading = screen.getByRole("heading", { level: 1 });
    const row = heading.closest(".flex-wrap");
    expect(row).toBeTruthy();
  });
});
