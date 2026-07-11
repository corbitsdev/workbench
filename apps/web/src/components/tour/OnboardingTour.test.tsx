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
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PreferenceSetting } from "@workbench/shared";
import { PREFERENCE_REGISTRY } from "@workbench/shared";

function settingsWith(tourDone: boolean): PreferenceSetting[] {
  return [
    {
      key: "onboardingTourDone",
      type: "boolean",
      default: false,
      label: "Onboarding tour completed",
      description: "Turn off to see the guided tour again.",
      category: "General",
      value: tourDone,
    },
  ];
}

let currentSettings: PreferenceSetting[] = settingsWith(false);

const getMePreferenceSettings = mock(async () => currentSettings);
const patchMePreferences = mock(
  async (_patch: Record<string, unknown>) => ({}),
);

mock.module("../../lib/hub-api", () => ({
  getMePreferenceSettings,
  patchMePreferences,
}));

import { OnboardingTourProvider, useTourLauncher } from "./OnboardingTour";
import { TOUR_STEPS } from "./tour-steps";

function LaunchButton() {
  const { startTour } = useTourLauncher();
  return (
    <button type="button" onClick={startTour}>
      Take the tour
    </button>
  );
}

function renderTour() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OnboardingTourProvider>
          <div data-tour="myra-chat" />
          <div data-tour="nav-inbox" />
          <div data-tour="notifications-bell" />
          <div data-tour="workflow-schedule" />
          <div data-tour="preference-agentAutonomy" />
          <LaunchButton />
        </OnboardingTourProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  currentSettings = settingsWith(false);
  window.happyDOM.setURL("http://localhost/");
});

afterEach(() => {
  getMePreferenceSettings.mockClear();
  patchMePreferences.mockClear();
  cleanup();
});

describe("tour step registry", () => {
  it("declares the v0.6 steps in order with content", () => {
    const ids = TOUR_STEPS.map((s) => s.id);
    expect(ids).toEqual([
      "myra",
      "inbox",
      "bell",
      "schedule",
      "autonomy",
    ]);
    for (const step of TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      expect(step.route.startsWith("/")).toBe(true);
    }
  });

  it("persists completion through a registered preference key", () => {
    const entry = PREFERENCE_REGISTRY.find(
      (e) => e.key === "onboardingTourDone",
    );
    if (!entry) throw new Error("onboardingTourDone not in registry");
    expect(entry.type).toBe("boolean");
    expect(entry.default).toBe(false);
  });
});

describe("OnboardingTour", () => {
  it("auto-launches on first load and shows the first step", async () => {
    renderTour();
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
    screen.getByText(TOUR_STEPS[0].body);
    screen.getByText(`1 of ${TOUR_STEPS.length}`);
  });

  it("advances with Next and returns with Back", async () => {
    renderTour();
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("dialog", { name: TOUR_STEPS[1].title });
    screen.getByText(`2 of ${TOUR_STEPS.length}`);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
  });

  it("skip persists the completion flag and closes the overlay", async () => {
    renderTour();
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
    fireEvent.click(screen.getByRole("button", { name: "Skip tour" }));
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      onboardingTourDone: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("finishing the last step persists the completion flag", async () => {
    renderTour();
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
    for (let i = 0; i < TOUR_STEPS.length - 1; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Next" }));
      await screen.findByRole("dialog", { name: TOUR_STEPS[i + 1].title });
    }
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0][0]).toEqual({
      onboardingTourDone: true,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape skips the tour", async () => {
    renderTour();
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not auto-launch when the flag is set, and relaunches on demand", async () => {
    currentSettings = settingsWith(true);
    renderTour();
    await screen.findByRole("button", { name: "Take the tour" });
    await waitFor(() => {
      if (getMePreferenceSettings.mock.calls.length === 0)
        throw new Error("settings not loaded");
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    await screen.findByRole("dialog", { name: TOUR_STEPS[0].title });
    expect(patchMePreferences.mock.calls.length).toBe(0);
  });
});
