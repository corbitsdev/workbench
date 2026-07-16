/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

mock.module("@workbench/settings", () => ({
  SettingsPage: () => <div>settings-page</div>,
}));

mock.module("@workbench/agents/browser", () => ({
  summarizeToolCalls: () => "tool summary",
  isToolSummaryStyle: () => false,
  TOOL_SUMMARY_STYLES: ["concise"],
  TOOL_SUMMARY_STYLE_LABELS: { concise: "Concise" },
  TOOL_SUMMARY_PREVIEW_CALLS: [],
}));

mock.module("../components/PreferencesPanel", () => ({
  PreferencesPanel: () => null,
}));

mock.module("../components/ConnectedToInboxPanel", () => ({
  ConnectedToInboxPanel: () => null,
}));

mock.module("../components/whats-new/WhatsNewSection", () => ({
  WhatsNewSection: () => null,
}));

mock.module("../components/tour/OnboardingTour", () => ({
  useTourLauncher: () => ({ startTour: () => {} }),
}));

mock.module("../components/AuthProvider", () => ({
  useAuth: () => ({
    session: { status: "authenticated" as const, user: { name: "Alice" } },
    signOut: async () => {},
  }),
}));

const getMeConnections = mock(async () => ({
  connections: [
    {
      provider: "linear",
      label: "Linear",
      connected: false,
      scopes: [],
      toggleEnabled: true,
      needsReconnect: false,
      configured: true,
    },
  ],
}));

mock.module("../lib/hub-api", () => ({
  // myra-variants (via MyraDefaultsPanel in the Settings import graph) binds
  // hubFetch at module load; the panel itself is not exercised here.
  hubFetch: async () => {
    throw new Error("not used in this test");
  },
  getMe: async () => ({ userId: "u1", userName: "Alice" }),
  patchMeProfile: async (name: string) => ({ userName: name }),
  getMePreferences: async () => ({ preferences: {} }),
  patchMePreferences: async () => ({ preferences: {} }),
  getWorkflowsCatalog: async () => ({ workflows: [] }),
  getMeConnections: () => getMeConnections(),
  authorizeMeConnection: async () => ({ redirectUrl: "https://example.test" }),
  listWorkbenches: async () => [],
  listMeSchedules: async () => [],
  createMeSchedule: async () => {
    throw new Error("not used in this test");
  },
  updateMeSchedule: async () => {
    throw new Error("not used in this test");
  },
  deleteMeSchedule: async () => {
    throw new Error("not used in this test");
  },
}));

const { default: Settings } = await import("./Settings");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;

function renderSettings(path = "/settings") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
  getMeConnections.mockClear();
});

describe("Settings connections section", () => {
  it("renders Connections inside Settings and loads member connections", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/version")) return jsonResponse({ buildSha: null });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    renderSettings();

    expect(screen.getByRole("heading", { name: "Connections" })).toBeDefined();
    await waitFor(() =>
      expect(getMeConnections.mock.calls.length).toBeGreaterThan(0),
    );
    await waitFor(() => expect(screen.getByText("Linear")));
  });
});
