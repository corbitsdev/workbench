/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactNode } from "react";
import type { PaletteSearchResponse } from "@workbench/shared";

// Mock the active workbench (a real tenant) and the server search at the module
// boundary so the entity path is driven deterministically. Static nav commands
// still come from the real router. mock.module is isolate-safe (the hub/web
// suites run with --isolate).
mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: "tn-1" }),
  ActiveWorkbenchProvider: ({ children }: { children: ReactNode }) => children,
}));

const searchSpy = mock(
  (
    _tenantId: string,
    query: string,
    page: number,
  ): Promise<PaletteSearchResponse> => {
    const match = query.toLowerCase().includes("acme");
    return Promise.resolve({
      results: match
        ? [
            {
              id: "conversation:c1",
              category: "conversation",
              title: "Acme call",
              to: "/chats/c1",
            },
          ]
        : [],
      page,
      hasMore: false,
    });
  },
);
mock.module("../lib/palette-search", () => ({
  searchPaletteEntities: searchSpy,
}));

const { CommandPaletteProvider } = await import("./command-palette-context");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <CommandPaletteProvider>
          <LocationProbe />
        </CommandPaletteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function pressCmdK() {
  act(() => {
    fireEvent.keyDown(document, { key: "k", metaKey: true });
  });
}

afterEach(() => {
  cleanup();
  searchSpy.mockClear();
});

describe("CommandPaletteProvider", () => {
  it("opens on Cmd+K and toggles closed on a second Cmd+K", () => {
    renderProvider();
    expect(screen.queryByRole("combobox")).toBeNull();

    pressCmdK();
    screen.getByRole("combobox");

    pressCmdK();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("resets the query when Cmd+K closes and reopens the palette", () => {
    renderProvider();
    pressCmdK();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "acme" } });
    expect(input.value).toBe("acme");

    // Cmd+K closes, Cmd+K reopens — the second open must show a fresh query,
    // not the stale "acme" left from the prior session.
    pressCmdK();
    expect(screen.queryByRole("combobox")).toBeNull();
    pressCmdK();
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });

  it("navigates to the selected nav command's route and closes", () => {
    renderProvider();
    pressCmdK();
    const input = screen.getByRole("combobox");
    // Enter fires before the search debounce, so only the client-side nav
    // command is present — selecting it navigates immediately.
    fireEvent.change(input, { target: { value: "artif" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByTestId("location").textContent).toBe("/artifacts");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("debounces a query to the server search and navigates to an entity result", async () => {
    renderProvider();
    pressCmdK();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "acme" } });

    // The debounced query reaches the server search with the active tenant.
    await waitFor(() => expect(searchSpy).toHaveBeenCalled(), {
      timeout: 2000,
    });
    expect(searchSpy.mock.calls[0]![0]).toBe("tn-1");

    // The matched title is split into highlight spans, so match on text content.
    await waitFor(() => {
      const titles = screen
        .getAllByRole("option")
        .map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Acme call"))).toBe(true);
    });
    const option = screen
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("Acme call"))!;
    fireEvent.click(option);
    expect(screen.getByTestId("location").textContent).toBe("/chats/c1");
  });
});
