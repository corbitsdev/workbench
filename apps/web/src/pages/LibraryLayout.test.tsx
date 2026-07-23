/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import LibraryLayout from "./LibraryLayout";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/library" element={<LibraryLayout />}>
          <Route
            path="artifacts"
            element={<div data-testid="view">Artifacts view</div>}
          />
          <Route
            path="skills"
            element={<div data-testid="view">Skills view</div>}
          />
          <Route
            path="agents"
            element={<div data-testid="view">Agents view</div>}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());

describe("LibraryLayout", () => {
  it("renders the three view tabs and the matched child view", () => {
    renderAt("/library/skills");
    screen.getByRole("link", { name: "Artifacts" });
    screen.getByRole("link", { name: "Skills" });
    screen.getByRole("link", { name: "Agents" });
    expect(screen.getByTestId("view").textContent).toBe("Skills view");
  });

  it("marks the tab for the current view as the current page", () => {
    renderAt("/library/agents");
    expect(
      screen.getByRole("link", { name: "Agents" }).getAttribute("aria-current"),
    ).toBe("page");
    expect(
      screen
        .getByRole("link", { name: "Artifacts" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("keeps each tab pointed at its own deep-linkable route", () => {
    renderAt("/library/artifacts");
    expect(
      screen.getByRole("link", { name: "Artifacts" }).getAttribute("href"),
    ).toBe("/library/artifacts");
    expect(
      screen.getByRole("link", { name: "Skills" }).getAttribute("href"),
    ).toBe("/library/skills");
    expect(
      screen.getByRole("link", { name: "Agents" }).getAttribute("href"),
    ).toBe("/library/agents");
  });
});
