/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

mock.module("react-router", () => ({
  useNavigate: () => mock(() => {}),
}));

import { ToolsLibrary } from "./ToolsLibrary";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const tools = [
  {
    name: "attio_query_records",
    providerName: "Attio",
    description: "Find or query records.",
    version: "0.2.3",
  },
  {
    name: "linear_list_issues",
    providerName: "Linear",
    description: "List Linear issues.",
    version: null,
  },
];

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/");
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/tools")) {
      return Promise.resolve(jsonResponse({ tools }));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(ToolsLibrary),
    ),
  );
}

describe("ToolsLibrary", () => {
  it("renders each tool with a humanized name and provider badge", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Attio query records"),
    );
    expect(document.body.textContent).not.toContain("attio_query_records");
    expect(document.body.textContent).toContain("Attio");
    expect(document.body.textContent).toContain("Linear list issues");
    expect(document.body.textContent).toContain("Linear");
  });

  it("shows the item count from the loaded catalog", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("2 items"));
  });

  it("shows version badge when tool has a resolved version", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("v0.2.3"));
  });

  it("omits version badge when version is null", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Linear list issues"),
    );
    expect(document.body.textContent).not.toContain("vnull");
  });

  it("groups tools under a heading per provider", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Attio query records"),
    );
    const headings = [...document.querySelectorAll("h2")].map(
      (h) => h.textContent ?? "",
    );
    expect(headings.some((t) => t.includes("Attio"))).toBe(true);
    expect(headings.some((t) => t.includes("Linear"))).toBe(true);
  });

  it("narrows to a single provider when the provider filter is set", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Attio query records"),
    );

    const select = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by provider"]',
    );
    if (!select) throw new Error("provider filter not rendered");
    fireEvent.change(select, { target: { value: "Linear" } });

    await waitFor(() =>
      expect(document.body.textContent).not.toContain("Attio query records"),
    );
    expect(document.body.textContent).toContain("Linear list issues");
    expect(document.body.textContent).toContain("1 items");
  });
});
