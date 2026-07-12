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
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { CHANGELOG } from "@workbench/shared";

const getMePreferences = mock(async () => ({}));
const getMePreferenceSettings = mock(async () => []);
const patchMePreferences = mock(
  async (patch: Record<string, unknown>) => patch,
);

mock.module("../../lib/hub-api", () => ({
  getMePreferences,
  getMePreferenceSettings,
  patchMePreferences,
}));

import { WhatsNewSection } from "./WhatsNewSection";

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WhatsNewSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  patchMePreferences.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("WhatsNewSection", () => {
  it("renders every release's version, date, and entries", () => {
    renderSection();
    for (const release of CHANGELOG) {
      screen.getByText(`${release.version} · ${release.date}`);
      for (const entry of release.entries) {
        screen.getByText(entry.title, { exact: false });
      }
    }
  });

  it("opens the walkthrough dialog for the latest release", async () => {
    renderSection();
    fireEvent.click(screen.getByText("View walkthrough"));
    const latest = CHANGELOG[0]!;
    await screen.findByRole("dialog", {
      name: `New in Workbench ${latest.version}`,
    });
  });

  it("Done in the reopened dialog stamps the changelog preference", async () => {
    renderSection();
    fireEvent.click(screen.getByText("View walkthrough"));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => {
      if (patchMePreferences.mock.calls.length === 0)
        throw new Error("no patch");
    });
    expect(patchMePreferences.mock.calls[0]?.[0]).toEqual({
      changelogSeenVersion: CHANGELOG[0]!.version,
    });
  });
});
