import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SidebarMenuButton } from "./sidebar";

afterEach(cleanup);

describe("SidebarMenuButton", () => {
  it("reflects defaults: inactive, default size data attributes", () => {
    render(<SidebarMenuButton>Item</SidebarMenuButton>);
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-active")).toBe("false");
    expect(button.getAttribute("data-size")).toBe("default");
    expect(button.getAttribute("data-sidebar")).toBe("menu-button");
  });

  it("marks itself active via the data-active attribute and active variant class", () => {
    render(<SidebarMenuButton isActive>Item</SidebarMenuButton>);
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-active")).toBe("true");
    expect(button.className).toContain("data-[active=true]:bg-sidebar-accent");
  });

  it("applies the outline variant and large size classes", () => {
    render(
      <SidebarMenuButton variant="outline" size="lg">
        Item
      </SidebarMenuButton>,
    );
    const button = screen.getByRole("button");
    expect(button.getAttribute("data-size")).toBe("lg");
    expect(button.className).toContain("border-sidebar-border");
    expect(button.className).toContain("h-12");
  });

  it("forwards click handlers and caller className", () => {
    let clicks = 0;
    render(
      <SidebarMenuButton className="extra" onClick={() => (clicks += 1)}>
        Item
      </SidebarMenuButton>,
    );
    const button = screen.getByRole("button");
    expect(button.className).toContain("extra");
    fireEvent.click(button);
    expect(clicks).toBe(1);
  });
});
