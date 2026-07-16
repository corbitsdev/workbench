/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

mock.module("../lib/hub-api", () => ({
  getMe: () =>
    Promise.resolve({
      userId: "u1",
      userName: "Test User",
      personalTenantId: "tenant-1",
      rootTenantIds: [],
      paInstanceId: null,
      provisioned: true,
      credentialResolved: true,
    }),
}));

const navigateSpy = mock((_to: string) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateSpy,
  useParams: () => ({ id: "gamma_generate" }),
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children as React.ReactNode),
}));

import { SettingsToolDetail } from "./SettingsToolDetail";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const gammaTool = {
  name: "gamma_generate",
  providerName: "gamma",
  description: "Generate a gamma deck.",
  inputSchema: { type: "object", properties: {} },
  version: null,
};

function toolFetch(providerName = "gamma", name = "gamma_generate") {
  return mock((url: string) => {
    if (url.includes("/tools/")) {
      return Promise.resolve(
        jsonResponse({ tool: { ...gammaTool, providerName, name } }),
      );
    }
    return Promise.resolve(jsonResponse([]));
  });
}

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/settings/tools/gamma_generate");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  navigateSpy.mockClear();
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SettingsToolDetail),
    ),
  );
}

describe("SettingsToolDetail", () => {
  it("shows the tool description and provider as deep-link context", async () => {
    globalThis.fetch = toolFetch() as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Generate a gamma deck."),
    );
    expect(document.body.textContent).toContain("gamma");
  });

  it("points to the Owner area for Gamma templates (no longer managed here)", async () => {
    globalThis.fetch = toolFetch("gamma") as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Owner area"),
    );
    // Template management UI (create form etc.) no longer lives on this page.
    expect(document.body.textContent).not.toContain("New template");
    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Owner area"),
    );
    expect(link?.getAttribute("href")).toBe("/settings/owner");
  });

  it("shows the graceful no-settings state for a non-gamma tool", async () => {
    globalThis.fetch = toolFetch(
      "attio",
      "attio_query",
    ) as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No additional settings for this tool.",
      ),
    );
  });

  it("navigates back to /settings", async () => {
    globalThis.fetch = toolFetch() as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Generate a gamma deck."),
    );
    const back = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Settings"),
    );
    await user.click(back as HTMLButtonElement);
    expect(navigateSpy).toHaveBeenCalledWith("/settings");
  });
});
