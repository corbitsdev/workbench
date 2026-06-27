import { afterEach, describe, expect, it } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./Menu";

afterEach(cleanup);

function Sample({ onPick = () => {} }: { onPick?: () => void }) {
  return (
    <Menu>
      <MenuTrigger>Actions</MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onPick}>First</MenuItem>
        <MenuItem>Second</MenuItem>
      </MenuContent>
    </Menu>
  );
}

// Radix opens on pointer/keyboard interaction; keyboard is the reliable driver
// under happy-dom (synthetic pointer events are not fully simulated).
function openMenu() {
  fireEvent.keyDown(screen.getByRole("button", { name: "Actions" }), {
    key: "ArrowDown",
  });
  return waitFor(() => screen.getByRole("menu"));
}

describe("Menu", () => {
  it("is closed until opened, then renders its items", async () => {
    render(<Sample />);
    expect(screen.queryByRole("menu")).toBeNull();
    await openMenu();
    screen.getByRole("menuitem", { name: "First" });
    screen.getByRole("menuitem", { name: "Second" });
  });

  it("renders the opaque branded surface class on the open content", async () => {
    render(<Sample />);
    const menu = await openMenu();
    expect(menu.className).toContain("wb-menu-surface");
    expect(menu.className).toContain("bg-surface");
  });

  it("closes and fires the item action on select", async () => {
    let picked = 0;
    render(<Sample onPick={() => (picked += 1)} />);
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "First" }));
    expect(picked).toBe(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("moves focus between items with the arrow keys", async () => {
    render(<Sample />);
    await openMenu();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("First"),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Second"),
    );
  });
});
