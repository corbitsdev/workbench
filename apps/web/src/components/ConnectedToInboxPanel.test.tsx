/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AvailableBriefSource,
  AvailableInboxSource,
  PreferenceSetting,
} from "@workbench/shared";

const SETTINGS: PreferenceSetting[] = [
  {
    key: "briefHourUtc",
    type: "hourUtc",
    default: 13,
    label: "Morning brief time",
    description: "When your morning brief arrives.",
    category: "Automations",
    value: 13,
  },
  {
    key: "notifyGateAsks",
    type: "boolean",
    default: true,
    label: "Approval requests",
    description: "Notify me when an agent needs my approval to proceed.",
    category: "Notifications",
    value: true,
  },
  {
    key: "taskMailEnabled",
    type: "boolean",
    default: true,
    label: "Task activity mail",
    description: "Notify me when a task is created for me.",
    category: "Notifications",
    value: false,
  },
  {
    key: "tasksTriageCreate",
    type: "boolean",
    default: true,
    label: "Triage may create tasks",
    description: "Let Myra's inbox triage leave a task behind.",
    category: "Automations",
    value: true,
  },
];

const BRIEF_SOURCES: AvailableBriefSource[] = [
  {
    key: "granola",
    label: "Granola calls",
    description: "Pull in recent call notes from Granola.",
    enabled: true,
  },
];

const INBOX_SOURCES: AvailableInboxSource[] = [
  {
    key: "granola",
    label: "Granola calls",
    description: "Pull in recent call notes from Granola.",
    enabled: true,
  },
];

const getMePreferenceSettings = mock(async () => SETTINGS);
const getMeBriefSources = mock(async () => BRIEF_SOURCES);
const getMeInboxSources = mock(async () => INBOX_SOURCES);

mock.module("../lib/hub-api", () => ({
  getMePreferenceSettings,
  getMeBriefSources,
  getMeInboxSources,
}));

import { ConnectedToInboxPanel } from "./ConnectedToInboxPanel";

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ConnectedToInboxPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  getMePreferenceSettings.mockClear();
  getMeBriefSources.mockClear();
  getMeInboxSources.mockClear();
  cleanup();
});

describe("ConnectedToInboxPanel", () => {
  it("renders the always-on feeds with their live preference state", async () => {
    renderPanel();
    await screen.findByText("Connected to your inbox");
    expect(screen.getByText("Morning brief")).toBeDefined();
    expect(screen.getByText("Mentions")).toBeDefined();
    expect(screen.getByText("Always on")).toBeDefined();
    // notifyGateAsks is true
    const approvalsRow = screen.getByText("Approvals & gates").closest("div");
    expect(approvalsRow?.textContent).toContain("On");
    // taskMailEnabled is false
    const taskRow = screen.getByText("Task activity").closest("div");
    expect(taskRow?.textContent).toContain("Off");
  });

  it("renders a row per external source with brief/inbox/task-creation status", async () => {
    renderPanel();
    await screen.findByText("Granola calls");
    const description = screen.getByText(
      "Pull in recent call notes from Granola.",
    );
    const row = description.closest("div");
    expect(row?.textContent).toContain("brief");
    expect(row?.textContent).toContain("inbox");
    expect(row?.textContent).toContain("can create tasks");
  });

  it("renders nothing when no preferences or sources are configured", () => {
    getMePreferenceSettings.mockImplementationOnce(async () => []);
    getMeBriefSources.mockImplementationOnce(async () => []);
    getMeInboxSources.mockImplementationOnce(async () => []);
    const { container } = renderPanel();
    expect(container.textContent).toBe("");
  });
});
