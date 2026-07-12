/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AvailableBriefSource,
  PreferenceSetting,
} from "@workbench/shared";

const SETTINGS: PreferenceSetting[] = [
  {
    key: "agentAutonomy",
    type: "select",
    default: "prepare_only",
    label: "Agent autonomy",
    description: "How far Myra may go on your behalf.",
    category: "Agent",
    options: [
      { value: "prepare_only", label: "Prepare only" },
      { value: "execute_with_gates", label: "Execute with gates" },
    ],
    value: "prepare_only",
  },
  {
    key: "notifyInboxMail",
    type: "boolean",
    default: true,
    label: "New inbox mail",
    description: "Notify me when a new message lands.",
    category: "Notifications",
    value: true,
  },
  {
    key: "briefHourUtc",
    type: "hourUtc",
    default: 13,
    label: "Morning brief time",
    description: "When your morning brief arrives.",
    category: "Agent",
    value: 13,
  },
];

const BRIEF_SOURCES: AvailableBriefSource[] = [
  {
    key: "granola",
    label: "Granola calls",
    description: "Pull in recent call notes from Granola.",
    enabled: true,
  },
  {
    key: "exa",
    label: "Exa research",
    description: "Pull in recent research from Exa.",
    enabled: false,
  },
];

const getMePreferenceSettings = mock(async () => SETTINGS);
const patchMePreferences = mock(
  async (_patch: Record<string, unknown>) => ({}),
);
const getMeBriefSources = mock(async () => BRIEF_SOURCES);

mock.module("../lib/hub-api", () => ({
  getMePreferenceSettings,
  patchMePreferences,
  getMeBriefSources,
}));

import { PreferencesPanel } from "./PreferencesPanel";

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PreferencesPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/settings");
});

afterEach(() => {
  getMePreferenceSettings.mockClear();
  patchMePreferences.mockClear();
  getMeBriefSources.mockClear();
  cleanup();
});

describe("PreferencesPanel", () => {
  it("renders settings grouped under their category headings", async () => {
    renderPanel();
    await screen.findByText("Agent autonomy");
    expect(screen.getByText("Agent")).toBeDefined();
    expect(screen.getByText("Notifications")).toBeDefined();
    expect(screen.getByText("New inbox mail")).toBeDefined();
  });

  it("PATCHes the selected key and value when a select changes", async () => {
    renderPanel();
    const select = (await screen.findByLabelText(
      "Agent autonomy",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "execute_with_gates" } });
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      agentAutonomy: "execute_with_gates",
    });
  });

  it("PATCHes a boolean key when a toggle is flipped", async () => {
    renderPanel();
    const toggle = await screen.findByRole("switch", {
      name: "New inbox mail",
    });
    fireEvent.click(toggle);
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      notifyInboxMail: false,
    });
  });

  it("labels the brief-hour select in local time and persists the UTC hour on change", async () => {
    renderPanel();
    const select = (await screen.findByLabelText(
      "Morning brief time",
    )) as HTMLSelectElement;

    const expectedLocalLabel = (utcHour: number): string => {
      const date = new Date();
      date.setUTCHours(utcHour, 0, 0, 0);
      return date.toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      });
    };

    expect(select.value).toBe("13");
    expect(select.options[select.selectedIndex]?.textContent).toBe(
      expectedLocalLabel(13),
    );
    expect(screen.getByText("Shown in your local time.")).toBeDefined();

    fireEvent.change(select, { target: { value: "9" } });
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      briefHourUtc: 9,
    });
  });

  it("renders a toggle for every brief source the hub returns, dynamically", async () => {
    renderPanel();
    await screen.findByText("Granola calls");
    expect(screen.getByText("Exa research")).toBeDefined();
    const granolaToggle = screen.getByRole("switch", {
      name: "Granola calls",
    });
    const exaToggle = screen.getByRole("switch", { name: "Exa research" });
    expect(granolaToggle.getAttribute("aria-checked")).toBe("true");
    expect(exaToggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders each brief source's catalog description under its toggle", async () => {
    renderPanel();
    await screen.findByText("Granola calls");
    expect(
      screen.getByText("Pull in recent call notes from Granola."),
    ).toBeDefined();
    expect(screen.getByText("Pull in recent research from Exa.")).toBeDefined();
  });

  it("does not render a brief source absent from the hub response", async () => {
    renderPanel();
    await screen.findByText("Granola calls");
    expect(screen.queryByText("Slack digest")).toBeNull();
  });

  it("PATCHes the brief-source-prefixed key when a source toggle flips", async () => {
    renderPanel();
    const exaToggle = await screen.findByRole("switch", {
      name: "Exa research",
    });
    fireEvent.click(exaToggle);
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      "briefSource:exa": true,
    });
  });
});
