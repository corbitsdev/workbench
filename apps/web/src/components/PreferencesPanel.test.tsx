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
import type { PreferenceSetting } from "@workbench/shared";

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
];

const getMePreferenceSettings = mock(async () => SETTINGS);
const patchMePreferences = mock(
  async (_patch: Record<string, unknown>) => ({}),
);

mock.module("../lib/hub-api", () => ({
  getMePreferenceSettings,
  patchMePreferences,
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
});
