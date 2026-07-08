import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

let meData: { isAdmin?: boolean; isOwner?: boolean } = {};
mock.module("../lib/hub-api", () => {
  const stub = async () => ({}) as any;
  return {
    getMe: () => Promise.resolve({ ...meData }),
    describeHubApiFailure: (e: unknown) => String(e),
    principalToWorkbenchEntry: (p: any) => p,
    getOwnerWorkflows: stub,
    setOwnerWorkflowEnabled: stub,
    getOwnerCredentials: stub,
    setOwnerCredential: stub,
    clearOwnerCredential: stub,
    postMe: stub,
    patchMePreferences: stub,
    patchMeProfile: stub,
    ensureMeSynced: stub,
    listMyraThreads: stub,
    createMyraThread: stub,
    renameMyraThread: stub,
    deleteMyraThread: stub,
    generateMyraThreadTitle: stub,
    getMyPrincipals: stub,
    principalsToWorkbenches: (p: any) => p,
    listWorkbenches: stub,
    listAgentInstances: stub,
    deleteAgentInstance: stub,
    launchInstanceSession: stub,
    stopAgentInstance: stub,
    listAgentTemplates: stub,
    upsertRating: () => {},
    getOutputFeedback: stub,
    saveOutputFeedback: stub,
    deployAgentFromTemplate: stub,
    getAnalyticsSummary: stub,
    getAnalyticsSummaryByAgent: stub,
    getModelPricing: stub,
    providerLogoUrl: () => "",
    getTenantProviders: stub,
    getTenantModels: stub,
    getActivityOverview: stub,
    getWorkflowsCatalog: stub,
    downloadActivityExportCsv: stub,
  };
});

const { CommandPaletteProvider } = await import("./command-palette-context");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderProvider(me?: { isAdmin?: boolean; isOwner?: boolean }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const meValue = me ?? {};
  queryClient.setQueryData(["me"], { ...meValue });
  meData = { ...meValue };
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
  meData = {};
});

describe("CommandPaletteProvider", () => {
  it("opens on Cmd+K and toggles closed on a second Cmd+K", () => {
    const r = renderProvider();
    expect(r.queryByRole("combobox")).toBeNull();

    pressCmdK();
    r.getByRole("combobox");

    pressCmdK();
    expect(r.queryByRole("combobox")).toBeNull();
  });

  it("resets the query when Cmd+K closes and reopens the palette", () => {
    const r = renderProvider();
    pressCmdK();
    const input = r.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "acme" } });
    expect(input.value).toBe("acme");

    // Cmd+K closes, Cmd+K reopens — the second open must show a fresh query,
    // not the stale "acme" left from the prior session.
    pressCmdK();
    expect(r.queryByRole("combobox")).toBeNull();
    pressCmdK();
    expect((r.getByRole("combobox") as HTMLInputElement).value).toBe("");
  });

  it("navigates to the selected nav command's route and closes", async () => {
    const r = renderProvider();
    pressCmdK();
    // Click the Artifacts row directly (avoids brittle fireEvent simulation of
    // controlled cmdk input for ranking + enter-to-select).
    const artifacts = r.getByRole("option", { name: "Artifacts" });
    fireEvent.click(artifacts);

    expect(r.getByTestId("location").textContent).toBe("/artifacts");
    expect(r.queryByRole("combobox")).toBeNull();
  });

  it("debounces a query to the server search and navigates to an entity result", async () => {
    const r = renderProvider();
    pressCmdK();
    const input = r.getByRole("combobox");
    await userEvent.type(input, "acme");

    // The debounced query reaches the server search with the active tenant.
    await waitFor(() => expect(searchSpy).toHaveBeenCalled(), {
      timeout: 2000,
    });
    expect(searchSpy.mock.calls[0]![0]).toBe("tn-1");

    // The matched title is split into highlight spans, so match on text content.
    await waitFor(() => {
      const titles = r.getAllByRole("option").map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Acme call"))).toBe(true);
    });
    const option = r
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("Acme call"))!;
    fireEvent.click(option);
    expect(r.getByTestId("location").textContent).toBe("/chats/c1");
  });

  describe("role-gated nav entries", () => {
    it("hides admin/owner/tools for non-admin non-owner", () => {
      const r = renderProvider({ isAdmin: false, isOwner: false });
      pressCmdK();
      const titles = r.getAllByRole("option").map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Admin"))).toBe(false);
      expect(titles.some((t) => t.includes("Owner"))).toBe(false);
      expect(titles.some((t) => t.includes("Tools"))).toBe(false);
      // ungated still present
      expect(titles.some((t) => t.includes("Chats"))).toBe(true);
    });

    it("shows admin+tools but hides owner for admin", () => {
      const r = renderProvider({ isAdmin: true, isOwner: false });
      pressCmdK();
      const titles = r.getAllByRole("option").map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Admin"))).toBe(true);
      expect(titles.some((t) => t.includes("Tools"))).toBe(true);
      expect(titles.some((t) => t.includes("Owner"))).toBe(false);
    });

    it("shows owner+admin+tools for owner", () => {
      const r = renderProvider({ isAdmin: true, isOwner: true });
      pressCmdK();
      const titles = r.getAllByRole("option").map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Admin"))).toBe(true);
      expect(titles.some((t) => t.includes("Owner"))).toBe(true);
      expect(titles.some((t) => t.includes("Tools"))).toBe(true);
    });

    it("non-admin search for admin yields no Admin nav entry", () => {
      const r = renderProvider({ isAdmin: false, isOwner: false });
      pressCmdK();
      const input = r.getByRole("combobox");
      act(() => {
        fireEvent.change(input, { target: { value: "admin" } });
      });
      // When no items match, cmdk shows empty state (role=presentation) instead
      // of option rows. Use queryAll to avoid throwing.
      const titles = r.queryAllByRole("option").map((o) => o.textContent ?? "");
      expect(titles.some((t) => t.includes("Admin"))).toBe(false);
    });
  });
});
