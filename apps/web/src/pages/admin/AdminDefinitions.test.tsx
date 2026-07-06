/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { definitionStatuses } from "@workbench/shared";

const useAdminDefinitions = mock((_filters: unknown) => ({
  data: {
    definitions: [
      {
        kind: "workflow" as const,
        key: "brief-builder",
        name: "Brief Builder",
        version: "3",
        status: "running",
        description: null,
        deploymentCount: 2,
        createdAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    pageInfo: { page: 1, limit: 25, total: 1, totalPages: 1 },
  },
  isLoading: false,
  isError: false,
}));

mock.module("../../hooks/use-admin", () => ({ useAdminDefinitions }));

import { AdminDefinitions } from "./AdminDefinitions";

let lastLocation = { pathname: "", search: "" };
function LocationProbe() {
  const loc = useLocation();
  lastLocation = { pathname: loc.pathname, search: loc.search };
  return null;
}

function renderAt(entry: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/admin/definitions"
            element={
              <>
                <AdminDefinitions />
                <LocationProbe />
              </>
            }
          />
          <Route path="/admin/definitions/:key" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useAdminDefinitions.mockClear();
  lastLocation = { pathname: "", search: "" };
});

describe("AdminDefinitions filters", () => {
  it("status filter is a select enumerating every known definition status", () => {
    renderAt("/admin/definitions");
    const select = screen.getByLabelText(
      "Filter by status",
    ) as HTMLSelectElement;
    // An "All statuses" default plus one <option> per real status vocab value.
    const optionValues = Array.from(within(select).getAllByRole("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(optionValues).toEqual(["", ...definitionStatuses]);
  });

  it("selecting a status writes it to the URL and resets to page 1", () => {
    renderAt("/admin/definitions?page=2");
    fireEvent.change(screen.getByLabelText("Filter by status"), {
      target: { value: "superseded" },
    });
    const params = new URLSearchParams(lastLocation.search);
    expect(params.get("status")).toBe("superseded");
    expect(params.get("page")).toBeNull();
  });

  it("navigates to detail carrying kind + origin filters as ?back=", () => {
    renderAt("/admin/definitions?page=2&status=running");
    fireEvent.click(screen.getByText("Brief Builder"));
    expect(lastLocation.pathname).toBe("/admin/definitions/brief-builder");
    const detailParams = new URLSearchParams(lastLocation.search);
    expect(detailParams.get("kind")).toBe("workflow");
    const restored = new URLSearchParams(
      decodeURIComponent(detailParams.get("back") ?? ""),
    );
    expect(restored.get("page")).toBe("2");
    expect(restored.get("status")).toBe("running");
  });
});
