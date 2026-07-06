/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const useAdminPrincipals = mock((_filters: unknown) => ({
  data: {
    principals: [
      {
        id: "prn_1",
        kind: "user" as const,
        refId: "u1",
        status: "active",
        displayName: "Ada Lovelace",
        roles: [],
        isAdmin: false,
      },
      {
        id: "prn_2",
        kind: "user" as const,
        refId: "u2",
        status: "active",
        displayName: "Grace Hopper",
        roles: [{ id: "rol_admin", name: "admin" }],
        isAdmin: true,
      },
    ],
    pageInfo: { page: 1, limit: 25, total: 2, totalPages: 1 },
  },
  isLoading: false,
  isError: false,
}));

mock.module("../../hooks/use-admin", () => ({ useAdminPrincipals }));

import { AdminPrincipals } from "./AdminPrincipals";

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
            path="/admin/principals"
            element={
              <>
                <AdminPrincipals />
                <LocationProbe />
              </>
            }
          />
          <Route path="/admin/principals/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function lastFilters(): { search?: string; type?: string; page: number } {
  const calls = useAdminPrincipals.mock.calls;
  return calls[calls.length - 1]?.[0] as never;
}

afterEach(() => {
  cleanup();
  useAdminPrincipals.mockClear();
  lastLocation = { pathname: "", search: "" };
});

describe("AdminPrincipals list", () => {
  it("renders a row for each returned principal", () => {
    renderAt("/admin/principals");
    expect(screen.getByText("Ada Lovelace").textContent).toBe("Ada Lovelace");
    expect(screen.getByText("Grace Hopper").textContent).toContain("Grace");
  });

  it("derives page + filters from the URL query string", () => {
    renderAt("/admin/principals?page=2&search=grace&type=agent");
    expect(lastFilters().page).toBe(2);
    expect(lastFilters().search).toBe("grace");
    expect(lastFilters().type).toBe("agent");
  });

  it("writes a typed search into the URL and resets to page 1", () => {
    renderAt("/admin/principals?page=3");
    fireEvent.change(screen.getByPlaceholderText("Search name or id…"), {
      target: { value: "grace" },
    });
    const params = new URLSearchParams(lastLocation.search);
    expect(params.get("search")).toBe("grace");
    expect(params.get("page")).toBeNull();
  });

  it("navigates to detail carrying origin filters as ?back= so return restores them", () => {
    renderAt("/admin/principals?page=2&search=grace");
    fireEvent.click(screen.getByText("Ada Lovelace"));
    expect(lastLocation.pathname).toBe("/admin/principals/prn_1");
    const back = new URLSearchParams(lastLocation.search).get("back");
    const restored = new URLSearchParams(decodeURIComponent(back ?? ""));
    expect(restored.get("page")).toBe("2");
    expect(restored.get("search")).toBe("grace");
  });
});
