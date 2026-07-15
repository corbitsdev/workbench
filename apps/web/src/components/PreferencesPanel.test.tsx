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
  AvailableInboxSource,
  MemberConnectionState,
  PreferenceSetting,
  WorkflowCatalog,
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
    availableWhen: { kind: "workflow-deployed", workflowKind: "heartbeat" },
  },
  {
    key: "briefHourUtc",
    type: "hourUtc",
    default: 13,
    label: "Morning brief time",
    description: "When your morning brief arrives.",
    category: "Agent",
    value: 13,
    availableWhen: { kind: "workflow-deployed", workflowKind: "heartbeat" },
  },
  {
    key: "timezone",
    type: "timezone",
    default: "",
    label: "Timezone",
    description: "Dates your agents see are rendered in this timezone.",
    category: "General",
    value: "",
  },
  {
    key: "tasksAutoSendAdapter",
    type: "boolean",
    default: false,
    label: "Auto-send tasks to CRM",
    description: "Push new tasks to your connected CRM automatically.",
    category: "Automations",
    value: false,
    availableWhen: { kind: "credential-connected", provider: "attio" },
  },
];

const EMPTY_WORKFLOW_CATALOG: WorkflowCatalog = { entries: [] };

const HEARTBEAT_DEPLOYED_CATALOG: WorkflowCatalog = {
  entries: [
    {
      kind: "heartbeat",
      label: "Heartbeat",
      isFavorite: false,
      stepCount: 1,
      pauseCount: 0,
      steps: [],
      attachable: false,
    },
  ],
};

const NO_CONNECTIONS: MemberConnectionState[] = [];

const ATTIO_CONNECTED: MemberConnectionState[] = [
  {
    provider: "attio",
    label: "Attio",
    connected: true,
    scopes: [],
    toggleEnabled: true,
    needsReconnect: false,
    configured: true,
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

// Distinct labels from BRIEF_SOURCES (same underlying keys) so the two
// independently-rendered toggle groups don't collide in the test DOM.
const INBOX_SOURCES: AvailableInboxSource[] = [
  {
    key: "granola",
    label: "Granola inbox notes",
    description: "Deliver call notes from Granola to your inbox.",
    enabled: true,
  },
  {
    key: "exa",
    label: "Exa inbox research",
    description: "Deliver research from Exa to your inbox.",
    enabled: true,
  },
];

let workflowCatalogResult: WorkflowCatalog = HEARTBEAT_DEPLOYED_CATALOG;
let connectionsResult: MemberConnectionState[] = ATTIO_CONNECTED;

const getMePreferenceSettings = mock(async () => SETTINGS);
const patchMePreferences = mock(
  async (_patch: Record<string, unknown>) => ({}),
);
const getMeBriefSources = mock(async () => BRIEF_SOURCES);
const getMeInboxSources = mock(async () => INBOX_SOURCES);
const getWorkflowsCatalog = mock(async () => workflowCatalogResult);
const getMeConnections = mock(async () => ({ connections: connectionsResult }));

mock.module("../lib/hub-api", () => ({
  getMePreferenceSettings,
  patchMePreferences,
  getMeBriefSources,
  getMeInboxSources,
  getWorkflowsCatalog,
  getMeConnections,
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
  workflowCatalogResult = HEARTBEAT_DEPLOYED_CATALOG;
  connectionsResult = ATTIO_CONNECTED;
});

afterEach(() => {
  getMePreferenceSettings.mockClear();
  patchMePreferences.mockClear();
  getMeBriefSources.mockClear();
  getMeInboxSources.mockClear();
  getWorkflowsCatalog.mockClear();
  getMeConnections.mockClear();
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

  it("renders a toggle for every inbox source the hub returns, independently of brief sources", async () => {
    renderPanel();
    await screen.findByText("Granola inbox notes");
    expect(screen.getByText("Exa inbox research")).toBeDefined();
    const granolaToggle = screen.getByRole("switch", {
      name: "Granola inbox notes",
    });
    expect(granolaToggle.getAttribute("aria-checked")).toBe("true");
  });

  it("PATCHes the inbox-source-prefixed key when an inbox toggle flips", async () => {
    renderPanel();
    const inboxToggle = await screen.findByRole("switch", {
      name: "Granola inbox notes",
    });
    fireEvent.click(inboxToggle);
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      "inboxSource:granola": false,
    });
  });

  it("toggling an inbox source off leaves the corresponding brief-source toggle on", async () => {
    renderPanel();
    const inboxToggle = await screen.findByRole("switch", {
      name: "Granola inbox notes",
    });
    fireEvent.click(inboxToggle);
    await waitFor(() => {
      const inboxCalls = patchMePreferences.mock.calls.filter(
        (call) => "inboxSource:granola" in call[0],
      );
      if (inboxCalls.length === 0) throw new Error("no inbox patch");
    });

    const briefToggle = screen.getByRole("switch", { name: "Granola calls" });
    expect(briefToggle.getAttribute("aria-checked")).toBe("true");
    expect(
      patchMePreferences.mock.calls.some(
        (call) => "briefSource:granola" in call[0],
      ),
    ).toBe(false);
  });

  it("hides workflow-deployed-gated settings when heartbeat is not deployed", async () => {
    workflowCatalogResult = EMPTY_WORKFLOW_CATALOG;
    renderPanel();
    await screen.findByText("Agent autonomy");
    await waitFor(() => {
      if (getWorkflowsCatalog.mock.calls.length === 0) {
        throw new Error("workflows catalog not fetched yet");
      }
    });
    expect(screen.queryByText("New inbox mail")).toBeNull();
    expect(screen.queryByLabelText("Morning brief time")).toBeNull();
  });

  it("shows workflow-deployed-gated settings when heartbeat is deployed", async () => {
    workflowCatalogResult = HEARTBEAT_DEPLOYED_CATALOG;
    renderPanel();
    await screen.findByText("New inbox mail");
    expect(screen.getByLabelText("Morning brief time")).toBeDefined();
  });

  it("hides credential-connected-gated settings when the provider is not connected", async () => {
    connectionsResult = NO_CONNECTIONS;
    renderPanel();
    await screen.findByText("Agent autonomy");
    await waitFor(() => {
      if (getMeConnections.mock.calls.length === 0) {
        throw new Error("connections not fetched yet");
      }
    });
    expect(screen.queryByText("Auto-send tasks to CRM")).toBeNull();
  });

  it("shows credential-connected-gated settings when the provider is connected", async () => {
    connectionsResult = ATTIO_CONNECTED;
    renderPanel();
    await screen.findByText("Auto-send tasks to CRM");
    expect(
      screen.getByRole("switch", { name: "Auto-send tasks to CRM" }),
    ).toBeDefined();
  });

  it("always renders ungated settings regardless of workflow/connection state", async () => {
    workflowCatalogResult = EMPTY_WORKFLOW_CATALOG;
    connectionsResult = NO_CONNECTIONS;
    renderPanel();
    await screen.findByText("Agent autonomy");
    expect(screen.getByLabelText("Agent autonomy")).toBeDefined();
  });
});

describe("timezone preference row", () => {
  it("renders a zone picker with an unset (UTC) option selected when no zone is stored", async () => {
    renderPanel();
    const select = (await screen.findByLabelText(
      "Timezone",
    )) as HTMLSelectElement;
    expect(select.value).toBe("");
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Not set (UTC)");
  });

  it("PATCHes the chosen IANA zone when the member picks one", async () => {
    renderPanel();
    const select = (await screen.findByLabelText(
      "Timezone",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "America/Los_Angeles" } });
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      timezone: "America/Los_Angeles",
    });
  });

  it("suggests the browser zone when unset and saves it only on confirm", async () => {
    const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    renderPanel();
    const suggestion = await screen.findByRole("button", {
      name: `Use ${browserZone}`,
    });
    // Rendering the suggestion saves nothing.
    expect(patchMePreferences.mock.calls.length).toBe(0);
    fireEvent.click(suggestion);
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      timezone: browserZone,
    });
  });
});
