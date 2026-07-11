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

// Unlike command-palette-context.test.tsx, this suite does NOT mock
// `searchPaletteEntities`. It stubs `globalThis.fetch` instead, so a typed
// keystroke flows through the WHOLE seam the unit tests each mocked away:
//   provider debounce → useInfiniteQuery → real searchPaletteEntities (URL build
//   + arktype parse at the trust boundary) → CommandPalette (cmdk render).
// This is the path that was silently broken: each half was green in isolation
// while the integrated query→render path surfaced no backend results. The test
// fails if any layer of that seam regresses.
mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({ activeTenantId: "tn-1" }),
  ActiveWorkbenchProvider: ({ children }: { children: ReactNode }) => children,
}));

const { CommandPaletteProvider } = await import("./command-palette-context");

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const ME_FIXTURE = {
  userId: "user_test",
  userName: "Test User",
  personalTenantId: null,
  rootTenantIds: [],
  paInstanceId: null,
  provisioned: true,
  credentialResolved: true,
};

function stubSearchFetch() {
  const captured: { searchUrl?: string } = {};
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/v1/me")) {
      return Promise.resolve(
        new Response(JSON.stringify(ME_FIXTURE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/search")) {
      captured.searchUrl = url;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            results: [
              {
                id: "artifact:a1",
                category: "artifact",
                title: "Q3 pricing one-pager",
                to: "/artifacts/a1",
              },
            ],
            page: 0,
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  return captured;
}

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

describe("command palette query→render integration", () => {
  it("fetches, parses, and renders a backend result for a typed query", async () => {
    const captured = stubSearchFetch();
    renderProvider();
    pressCmdK();

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "pricing" } });

    // The real searchPaletteEntities builds the tenant-scoped URL and parses
    // the server payload through the shared arktype schema.
    await waitFor(() => expect(captured.searchUrl).toBeDefined(), {
      timeout: 2000,
    });
    expect(captured.searchUrl).toContain("/api/tenants/tn-1/search");
    expect(captured.searchUrl).toContain("q=pricing");

    // The parsed backend row renders under its server category group, alongside
    // the static GO TO nav group — proving server results actually surface.
    await waitFor(() => {
      const titles = screen
        .getAllByRole("option")
        .map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Q3 pricing one-pager"))).toBe(true);
    });
    screen.getByText("Artifacts");
  });

  it("navigates to a backend result's route when selected", async () => {
    stubSearchFetch();
    renderProvider();
    pressCmdK();

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "pricing" } });

    await waitFor(() => {
      const option = screen
        .getAllByRole("option")
        .find((o) => (o.textContent ?? "").includes("Q3 pricing one-pager"));
      expect(option).toBeDefined();
    });
    const option = screen
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("Q3 pricing one-pager"))!;
    fireEvent.click(option);

    expect(screen.getByTestId("location").textContent).toBe("/artifacts/a1");
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
