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
import { MemoryRouter } from "react-router";

type MockField = { key: string; label: string; kind: string };

mock.module("@workbench/settings", () => ({
  SettingsPage: ({
    sections,
    values,
    onChange,
  }: {
    sections: readonly { fields: readonly MockField[] }[];
    values: Record<string, unknown>;
    onChange: (key: string, value: string) => void;
  }) => (
    <div>
      settings-page
      {sections.flatMap((section) =>
        section.fields.map((field) =>
          field.kind === "text" ? (
            <input
              key={field.label}
              aria-label={field.label}
              value={
                typeof values[field.key] === "string"
                  ? (values[field.key] as string)
                  : ""
              }
              onChange={(e) => onChange(field.key, e.target.value)}
            />
          ) : (
            <span key={field.label}>{field.label}</span>
          ),
        ),
      )}
    </div>
  ),
}));

mock.module("@workbench/agents/browser", () => ({
  summarizeToolCalls: () => "tool summary",
  isToolSummaryStyle: () => false,
  TOOL_SUMMARY_STYLES: ["concise"],
  TOOL_SUMMARY_STYLE_LABELS: { concise: "Concise" },
  TOOL_SUMMARY_PREVIEW_CALLS: [],
}));

const startTourMock = mock(() => {});

mock.module("../components/tour/OnboardingTour", () => ({
  useTourLauncher: () => ({ startTour: startTourMock }),
}));

const signOutMock = mock(() => Promise.resolve());

mock.module("../components/AuthProvider", () => ({
  useAuth: () => ({
    session: {
      status: "authenticated" as const,
      user: { name: "Alice", email: "alice@example.com" },
    },
    signOut: signOutMock,
  }),
}));

import { default as Settings } from "./Settings";

const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Every Settings render mounts the Schedules section, which fetches these two
// endpoints regardless of which behavior a given test is exercising.
function handleSchedulesFetches(url: string): Response | null {
  if (url.includes("/me/schedules")) return jsonResponse({ items: [] });
  if (url.includes("/workflows")) return jsonResponse({ entries: [] });
  return null;
}

function stubVersion(body: unknown, ok = true) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const scheduled = handleSchedulesFetches(url);
    if (scheduled) return scheduled;
    if (url.includes("/version")) {
      return jsonResponse(body, ok ? 200 : 500);
    }
    if (url.includes("/api/v1/me")) {
      return jsonResponse({ userId: "u1", userName: "" });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function neverResolvingVersion() {
  globalThis.fetch = ((_input: RequestInfo | URL) =>
    new Promise<Response>(() => {})) as typeof fetch;
}

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Settings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/settings");
  signOutMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function bodyText() {
  return document.body.textContent ?? "";
}

describe("Settings preferences", () => {
  it("exposes the experimental artifact cards toggle", () => {
    neverResolvingVersion();
    renderSettings();
    expect(bodyText().includes("Experimental artifact cards")).toBe(true);
  });
});

describe("Settings display name", () => {
  it("seeds the display name field from the persisted userName", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const scheduled = handleSchedulesFetches(url);
      if (scheduled) return scheduled;
      if (url.includes("/api/v1/me"))
        return jsonResponse({ userId: "u1", userName: "Persisted Name" });
      if (url.includes("/version")) return jsonResponse({ buildSha: null });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    renderSettings();

    await waitFor(() => {
      const input = screen.getByLabelText("Display name") as HTMLInputElement;
      if (input.value !== "Persisted Name")
        throw new Error(`not seeded: ${input.value}`);
    });
  });

  it("PATCHes an edited name to /me/profile and surfaces the saved state", async () => {
    const calls: { url: string; method?: string; body?: BodyInit | null }[] =
      [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init?.method, body: init?.body ?? null });
      const scheduled = handleSchedulesFetches(url);
      if (scheduled) return scheduled;
      if (url.includes("/api/v1/me/profile"))
        return jsonResponse({ userName: "New Name" });
      if (url.includes("/api/v1/me"))
        return jsonResponse({ userId: "u1", userName: "Old Name" });
      if (url.includes("/version")) return jsonResponse({ buildSha: null });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    renderSettings();

    const input = await screen.findByLabelText("Display name");
    fireEvent.change(input, { target: { value: "New Name" } });
    fireEvent.click(await screen.findByText("Save display name"));

    await waitFor(() => {
      if (!bodyText().includes("Display name saved."))
        throw new Error("success not shown");
    });

    const patch = calls.find((c) => c.url.includes("/api/v1/me/profile"));
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toBe(JSON.stringify({ displayName: "New Name" }));
  });
});

describe("Settings build version display", () => {
  it("shows the 7-char short SHA from /version", async () => {
    stubVersion({ buildSha: "abc1234def5678" });
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build abc1234"))
        throw new Error("short SHA not rendered");
    });
    // Only the short form, never the full 40-char value.
    expect(bodyText().includes("abc1234def5678")).toBe(false);
  });

  it("shows a loading placeholder while the query is pending", () => {
    neverResolvingVersion();
    renderSettings();
    expect(bodyText().includes("build …")).toBe(true);
  });

  it('shows "build unknown" when the SHA is null (local dev)', async () => {
    stubVersion({ buildSha: null });
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build unknown"))
        throw new Error("unknown not rendered");
    });
  });

  it('shows "build unknown" when /version returns an unexpected shape', async () => {
    stubVersion({ unexpected: "shape" });
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build unknown"))
        throw new Error("unknown not rendered");
    });
  });

  it('shows "build unknown" when the /version request fails', async () => {
    stubVersion({}, false);
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build unknown"))
        throw new Error("unknown not rendered");
    });
  });
});

describe("Settings general preferences", () => {
  it("renders General-category preferences in the Account section", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const scheduled = handleSchedulesFetches(url);
      if (scheduled) return scheduled;
      if (url.includes("/me/preferences/settings"))
        return jsonResponse({
          settings: [
            {
              key: "onboardingTourDone",
              label: "Onboarding tour completed",
              description:
                "Whether the guided introduction has been completed.",
              type: "boolean",
              default: false,
              value: true,
              category: "General",
            },
          ],
        });
      if (url.includes("/api/v1/me"))
        return jsonResponse({ userId: "u1", userName: "" });
      if (url.includes("/version")) return jsonResponse({ buildSha: null });
      throw new Error(`unexpected fetch to ${url}`);
    }) as typeof fetch;

    renderSettings();

    const label = await screen.findByText("Onboarding tour completed");
    expect(label.closest("section#account")).not.toBeNull();
  });
});

describe("Settings onboarding tour", () => {
  it("relaunches the tour from the Take the tour button", () => {
    neverResolvingVersion();
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: "Take the tour" }));
    expect(startTourMock).toHaveBeenCalledTimes(1);
  });
});

describe("Settings sign out", () => {
  it("renders a Sign out button", () => {
    neverResolvingVersion();
    renderSettings();
    expect(
      screen.getByRole("button", { name: /sign out/i }).textContent,
    ).toMatch(/sign out/i);
  });

  it("calls signOut when the button is clicked", () => {
    neverResolvingVersion();
    renderSettings();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalledTimes(1);
  });
});
