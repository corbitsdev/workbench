/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

const setActiveWorkbench = mock((_id: string) => {});
let ctx: {
  workbenches: {
    id: string;
    tenantSlug: string;
    tenantName: string;
    tenantId: string;
  }[];
  loading: boolean;
  activeWorkbench: { id: string; tenantName: string } | null;
  activeTenantId: string | null;
  setActiveWorkbench: (id: string) => void;
};

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ctx,
}));

const { WorkbenchSelector } = require("./WorkbenchSelector");

beforeEach(() => {
  setActiveWorkbench.mockClear();
});
afterEach(() => cleanup());

describe("WorkbenchSelector", () => {
  it("renders nothing when the member has no workbenches", () => {
    ctx = {
      workbenches: [],
      loading: false,
      activeWorkbench: null,
      activeTenantId: null,
      setActiveWorkbench,
    };
    const { container } = render(React.createElement(WorkbenchSelector));
    expect(container.textContent).toBe("");
  });

  it("shows the active workbench and switches tenancy on select", () => {
    ctx = {
      workbenches: [
        {
          id: "p1",
          tenantSlug: "acme",
          tenantName: "Acme Corp",
          tenantId: "t1",
        },
        {
          id: "p2",
          tenantSlug: "globex",
          tenantName: "Globex",
          tenantId: "t2",
        },
      ],
      loading: false,
      activeWorkbench: { id: "p1", tenantName: "Acme Corp" },
      activeTenantId: "t1",
      setActiveWorkbench,
    };
    render(React.createElement(WorkbenchSelector));
    expect(screen.getByText("Acme Corp")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.click(screen.getByRole("option", { name: "Globex" }));
    expect(setActiveWorkbench).toHaveBeenCalledWith("p2");
  });
});
