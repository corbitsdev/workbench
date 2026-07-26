/// <reference types="bun" />
import "./test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RichEmptyState } from "./RichEmptyState";
import { THEMES } from "./use-theme";

afterEach(cleanup);

describe("RichEmptyState", () => {
  it("renders icon, title, description, and actions", () => {
    const onPrimary = mock(() => undefined);
    render(
      <RichEmptyState
        icon={<span data-testid="glyph">◇</span>}
        title="Nothing here"
        description="Try creating one."
        actions={[
          { label: "Create", onClick: onPrimary, variant: "primary" },
          { label: "Learn more", href: "/docs", variant: "secondary" },
        ]}
      />,
    );
    screen.getByTestId("rich-empty-state");
    screen.getByTestId("glyph");
    screen.getByRole("heading", { name: "Nothing here" });
    screen.getByText("Try creating one.");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onPrimary).toHaveBeenCalled();
    const link = screen.getByRole("link", { name: "Learn more" });
    expect(link.getAttribute("href")).toBe("/docs");
  });

  it("uses token classes under each brand theme", () => {
    for (const theme of THEMES) {
      document.documentElement.setAttribute("data-theme", theme);
      const { unmount } = render(
        <RichEmptyState title="Empty" description="No items." />,
      );
      const root = screen.getByTestId("rich-empty-state");
      expect(root.className).toContain("bg-surface");
      expect(root.className).toContain("border-border");
      unmount();
    }
    document.documentElement.removeAttribute("data-theme");
  });
});
