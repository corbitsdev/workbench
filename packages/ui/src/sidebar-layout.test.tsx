import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
} from "./sidebar";

afterEach(cleanup);

describe("sidebar layout primitives", () => {
  it("renders the composed structure with the expected tags and merged classes", () => {
    const { container } = render(
      <Sidebar className="root">
        <SidebarHeader className="hdr">Header</SidebarHeader>
        <SidebarContent className="content">
          <SidebarGroup className="grp">
            <SidebarGroupLabel className="lbl">Label</SidebarGroupLabel>
            <SidebarGroupContent className="grpc">
              <SidebarMenu className="menu">
                <SidebarMenuItem className="item">Item</SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="ftr">Footer</SidebarFooter>
      </Sidebar>,
    );

    const root = container.firstChild as HTMLElement;
    expect(root.className).toContain("bg-sidebar");
    expect(root.className).toContain("root");

    expect(container.querySelector(".hdr")?.className).toContain("border-b");
    expect(container.querySelector(".ftr")?.className).toContain("mt-auto");
    expect(container.querySelector(".content")?.className).toContain(
      "overflow-y-auto",
    );
    expect(container.querySelector(".grp")?.className).toContain(
      "overflow-hidden",
    );

    const label = container.querySelector(".lbl") as HTMLElement;
    expect(label.tagName).toBe("SPAN");
    expect(label.className).toContain("text-xs");

    expect(container.querySelector(".grpc")?.className).toContain("text-sm");

    const menu = container.querySelector(".menu") as HTMLElement;
    expect(menu.tagName).toBe("UL");
    expect(menu.className).toContain("flex-col");

    const item = container.querySelector(".item") as HTMLElement;
    expect(item.tagName).toBe("LI");
    expect(item.className).toContain("relative");
  });
});
