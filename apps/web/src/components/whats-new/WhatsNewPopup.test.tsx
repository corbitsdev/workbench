/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { MemberPreferences, PreferenceSetting } from "@workbench/shared";
import { latestChangelogVersion } from "@workbench/shared";

function tourSetting(done: boolean): PreferenceSetting {
  return {
    key: "onboardingTourDone",
    type: "boolean",
    default: false,
    label: "Onboarding tour completed",
    description: "Turn off to see the guided tour again.",
    category: "General",
    value: done,
  };
}

let preferences: MemberPreferences = {};
let settings: PreferenceSetting[] = [tourSetting(true)];

const getMePreferences = mock(async () => preferences);
const getMePreferenceSettings = mock(async () => settings);
const patchMePreferences = mock(async (patch: Record<string, unknown>) => {
  preferences = { ...preferences, ...patch };
  return preferences;
});

mock.module("../../lib/hub-api", () => ({
  getMePreferences,
  getMePreferenceSettings,
  patchMePreferences,
}));

import { WhatsNewPopup } from "./WhatsNewPopup";

function renderPopup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WhatsNewPopup />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  preferences = {};
  settings = [tourSetting(true)];
  getMePreferences.mockClear();
  getMePreferenceSettings.mockClear();
  patchMePreferences.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("WhatsNewPopup", () => {
  it("shows when the tour is done and the changelog is unseen", async () => {
    renderPopup();
    await screen.findByText(`New in Workbench ${latestChangelogVersion()}`);
  });

  it("stays hidden while the tour has not finished", async () => {
    settings = [tourSetting(false)];
    renderPopup();
    await waitFor(() => {
      if (getMePreferenceSettings.mock.calls.length === 0)
        throw new Error("settings not loaded");
    });
    expect(
      screen.queryByText(`New in Workbench ${latestChangelogVersion()}`),
    ).toBeNull();
  });

  it("stays hidden once the version has already been seen", async () => {
    preferences = { changelogSeenVersion: latestChangelogVersion() };
    renderPopup();
    await waitFor(() => {
      if (getMePreferences.mock.calls.length === 0)
        throw new Error("preferences not loaded");
    });
    expect(
      screen.queryByText(`New in Workbench ${latestChangelogVersion()}`),
    ).toBeNull();
  });

  it("dismissing stamps the preference and hides the pop-up", async () => {
    renderPopup();
    await screen.findByText(`New in Workbench ${latestChangelogVersion()}`);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText(`New in Workbench ${latestChangelogVersion()}`),
    ).toBeNull();
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0]?.[0]).toEqual({
      changelogSeenVersion: latestChangelogVersion(),
    });
  });

  it("opens the walkthrough dialog from 'See what's new'", async () => {
    renderPopup();
    await screen.findByText(`New in Workbench ${latestChangelogVersion()}`);
    fireEvent.click(screen.getByText("See what's new"));
    await screen.findByRole("dialog", {
      name: `New in Workbench ${latestChangelogVersion()}`,
    });
  });
});
