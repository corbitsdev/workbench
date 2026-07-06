import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Breadcrumbs } from "./Breadcrumbs";

afterEach(cleanup);

function renderLink(to: string, label: string) {
  return <a href={to}>{label}</a>;
}

describe("Breadcrumbs", () => {
  it("links every non-last crumb that has a `to` via renderLink", () => {
    render(
      <Breadcrumbs
        renderLink={renderLink}
        items={[
          { label: "Admin", to: "/admin" },
          { label: "Definitions", to: "/admin/definitions" },
          { label: "Brief Builder" },
        ]}
      />,
    );
    expect(screen.getByText("Admin").closest("a")?.getAttribute("href")).toBe(
      "/admin",
    );
    expect(
      screen.getByText("Definitions").closest("a")?.getAttribute("href"),
    ).toBe("/admin/definitions");
  });

  it("renders the last crumb as plain text, not a link", () => {
    render(
      <Breadcrumbs
        renderLink={renderLink}
        items={[{ label: "Admin", to: "/admin" }, { label: "Brief Builder" }]}
      />,
    );
    expect(screen.getByText("Brief Builder").closest("a")).toBeNull();
  });

  it("renders crumbs as plain text when no renderLink is supplied", () => {
    render(
      <Breadcrumbs
        items={[{ label: "Admin", to: "/admin" }, { label: "Here" }]}
      />,
    );
    expect(screen.getByText("Admin").closest("a")).toBeNull();
  });
});
