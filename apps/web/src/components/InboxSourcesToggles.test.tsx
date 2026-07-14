/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type {
  AvailableInboxSource,
  MemberConnections,
  PreferenceSetting,
} from "@workbench/shared";

const INBOX_SOURCES: AvailableInboxSource[] = [
  {
    key: "linear",
    label: "Linear",
    description: "New Linear activity assigned to you lands in your inbox.",
    enabled: false,
  },
  {
    key: "granola",
    label: "Granola",
    description: "Granola calls are processed and mailed to participants.",
    enabled: true,
  },
];

const CONNECTIONS: MemberConnections = {
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
};

const SETTINGS: PreferenceSetting[] = [
  {
    key: "inboxSource:linear:scope",
    type: "select",
    default: "assigned",
    label: "Linear activity scope",
    description: "scope",
    category: "Inbox",
    options: [
      { value: "assigned", label: "Assigned issues + mentions" },
      { value: "all", label: "All activity on issues you're involved in" },
    ],
    value: "assigned",
  },
  {
    key: "inboxSource:linear:backfill",
    type: "select",
    default: "none",
    label: "Linear backfill on enable",
    description: "backfill",
    category: "Inbox",
    options: [
      { value: "none", label: "None — start from now" },
      { value: "7d", label: "Last 7 days" },
      { value: "30d", label: "Last 30 days" },
    ],
    value: "none",
  },
];

const getMeInboxSources = mock(async () => INBOX_SOURCES);
const getMeConnections = mock(async () => CONNECTIONS);
const getMePreferenceSettings = mock(async () => SETTINGS);
const patchMePreferences = mock(async () => ({}));

mock.module("../lib/hub-api", () => ({
  getMeInboxSources,
  getMeConnections,
  getMePreferenceSettings,
  patchMePreferences,
}));

import { InboxSourcesToggles } from "./InboxSourcesToggles";

function renderComponent() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <InboxSourcesToggles />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  getMeInboxSources.mockClear();
  getMeConnections.mockClear();
  getMePreferenceSettings.mockClear();
  patchMePreferences.mockClear();
  cleanup();
});

describe("InboxSourcesToggles", () => {
  it("renders each source with its inbox-specific description", async () => {
    renderComponent();
    await screen.findByText("Linear");
    expect(
      screen.getByText(
        "New Linear activity assigned to you lands in your inbox.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText(
        "Granola calls are processed and mailed to participants.",
      ),
    ).toBeDefined();
  });

  it("shows a connect affordance instead of a status label when Linear is not OAuth-connected", async () => {
    renderComponent();
    await screen.findByText("Linear");
    expect(screen.getByText("Connect your account")).toBeDefined();
  });

  it("shows 'Using workspace key' for a non-OAuth source", async () => {
    renderComponent();
    await screen.findByText("Granola");
    expect(screen.getByText("Using workspace key")).toBeDefined();
  });

  it("only renders the Linear scope/backfill options once Linear is enabled", async () => {
    renderComponent();
    await screen.findByText("Linear");
    expect(screen.queryByText("What counts as activity")).toBeNull();
  });

  it("renders nothing while loading or on error", () => {
    getMeInboxSources.mockImplementationOnce(
      () => new Promise<AvailableInboxSource[]>(() => {}),
    );
    const { container } = renderComponent();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when no sources are available (owner-disabled/unconfigured sources filtered server-side)", async () => {
    getMeInboxSources.mockImplementationOnce(async () => []);
    const { container } = renderComponent();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.textContent).toBe("");
  });
});

describe("InboxSourcesToggles — Linear enabled", () => {
  it("renders the scope and backfill selects when Linear is enabled, seeded with the stored values", async () => {
    getMeInboxSources.mockImplementationOnce(async () => [
      { ...INBOX_SOURCES[0]!, enabled: true },
    ]);
    renderComponent();
    await screen.findByText("What counts as activity");
    const scopeSelect = screen.getByLabelText(
      "What counts as activity",
    ) as HTMLSelectElement;
    expect(scopeSelect.value).toBe("assigned");
    const backfillSelect = screen.getByLabelText(
      "Backfill on enable",
    ) as HTMLSelectElement;
    expect(backfillSelect.value).toBe("none");
  });

  it("writes the scope preference when changed", async () => {
    getMeInboxSources.mockImplementationOnce(async () => [
      { ...INBOX_SOURCES[0]!, enabled: true },
    ]);
    renderComponent();
    await screen.findByText("What counts as activity");
    const scopeSelect = screen.getByLabelText("What counts as activity");
    fireEvent.change(scopeSelect, { target: { value: "all" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patchMePreferences).toHaveBeenCalledWith({
      "inboxSource:linear:scope": "all",
    });
  });
});
