/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PageChromeProvider, usePageChromeSlot } from "../lib/page-chrome";

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

const defaultMe = {
  userId: "u1",
  userName: "Test User",
  personalTenantId: "tenant-1" as string | null,
  rootTenantIds: [],
  paInstanceId: null,
  provisioned: true,
  credentialResolved: true,
};

let meImpl: () => Promise<typeof defaultMe> = () => Promise.resolve(defaultMe);

mock.module("../lib/hub-api", () => ({
  getMe: () => meImpl(),
}));

mock.module("react-router", () => ({
  useNavigate: () => mock(() => {}),
}));

import { AgentsPage, filterAgents } from "./AgentsPage";
import type { AgentInstanceItem } from "../hooks/use-agents";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const agents = [
  {
    id: "ins-1",
    agentId: "agt-1",
    agentName: "Oat",
    agentDescription: "Shared workspace agent",
    tenantId: "tenant-1",
    address: "ins-1@tenant-1.localhost",
    status: "running",
  },
  {
    id: "ins-2",
    agentId: "agt-2",
    agentName: "Loop",
    agentDescription: null,
    tenantId: "tenant-1",
    address: "ins-2@tenant-1.localhost",
    status: "stopped",
  },
];

let fetchImpl: (url: string) => Promise<Response> = (url) => {
  if (String(url).includes("/agents")) {
    return Promise.resolve(jsonResponse({ data: agents }));
  }
  return Promise.resolve(jsonResponse({}));
};

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/");
  meImpl = () => Promise.resolve(defaultMe);
  fetchImpl = (url) => {
    if (String(url).includes("/agents")) {
      return Promise.resolve(jsonResponse({ data: agents }));
    }
    return Promise.resolve(jsonResponse({}));
  };
  globalThis.fetch = mock((url: string) =>
    fetchImpl(url),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function ChromeSlotProbe() {
  return React.createElement(
    "div",
    { "data-testid": "chrome-slot" },
    usePageChromeSlot(),
  );
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(
        PageChromeProvider,
        null,
        React.createElement(ChromeSlotProbe),
        React.createElement(AgentsPage),
      ),
    ),
  );
}

describe("AgentsPage", () => {
  it("shows loading state before agents resolve", () => {
    renderPage();
    expect(document.body.textContent).toContain("Loading agents");
  });

  it("renders each agent's name, description, status, and address once loaded", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("Oat"));
    expect(document.body.textContent).toContain("Shared workspace agent");
    expect(document.body.textContent).toContain("Running");
    expect(document.body.textContent).toContain("ins-1@tenant-1.localhost");

    expect(document.body.textContent).toContain("Loop");
    expect(document.body.textContent).toContain("Stopped");
  });

  it("exposes a copy control for each agent mailbox address", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { getByLabelText } = renderPage();
    await waitFor(() =>
      expect(
        getByLabelText("Copy address ins-1@tenant-1.localhost"),
      ).toBeTruthy(),
    );

    fireEvent.click(getByLabelText("Copy address ins-1@tenant-1.localhost"));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("ins-1@tenant-1.localhost");
  });

  it("exposes a search field in the page chrome", async () => {
    const { getByLabelText } = renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("Oat"));
    expect(getByLabelText("Search agents")).toBeTruthy();
  });

  it("filterAgents matches name, description, and address", () => {
    const items: AgentInstanceItem[] = [
      {
        id: "1",
        agentId: "a1",
        name: "Oat",
        description: "Shared workspace agent",
        tenantId: "t",
        address: "ins-1@tenant-1.localhost",
        status: "running",
      },
      {
        id: "2",
        agentId: "a2",
        name: "Loop",
        description: null,
        tenantId: "t",
        address: "ins-2@tenant-1.localhost",
        status: "stopped",
      },
    ];
    expect(filterAgents(items, "loop").map((a) => a.name)).toEqual(["Loop"]);
    expect(filterAgents(items, "shared").map((a) => a.name)).toEqual(["Oat"]);
    expect(filterAgents(items, "ins-2").map((a) => a.name)).toEqual(["Loop"]);
    expect(filterAgents(items, "zzzz")).toEqual([]);
    expect(filterAgents(items, "  ").map((a) => a.name)).toEqual([
      "Oat",
      "Loop",
    ]);
  });

  it("switches between card and row layouts", async () => {
    const { getByRole } = renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("Oat"));

    // Default view mode is grid (cards); switch to rows for the table.
    fireEvent.click(getByRole("button", { name: "Rows view" }));
    await waitFor(() => {
      expect(document.body.querySelector("table")).toBeTruthy();
    });

    fireEvent.click(getByRole("button", { name: "Grid view" }));
    await waitFor(() => {
      expect(document.body.querySelector("table")).toBeNull();
      expect(document.body.textContent).toContain("Oat");
    });
  });

  it("shows an error message when the agents request fails", async () => {
    fetchImpl = () => Promise.reject(new Error("network down"));
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Could not load agents"),
    );
  });

  it("shows the empty state when there are no agents", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents")) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    };
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("No agents yet"),
    );
    expect(document.body.textContent).toContain(
      "Agents available to you will appear here",
    );
    expect(document.body.textContent).not.toContain("coming soon");
  });

  it("shows the error state when the identity request fails", async () => {
    meImpl = () => Promise.reject(new Error("me failed"));
    const { getByText, queryByText } = renderPage();
    await waitFor(() => {
      getByText("Could not load agents.");
    });
    expect(queryByText(/No agents yet/)).toBeNull();
  });

  it("shows the error state, not the empty state, when no personal tenant resolves", async () => {
    meImpl = () => Promise.resolve({ ...defaultMe, personalTenantId: null });
    const { getByText, queryByText } = renderPage();
    await waitFor(() => {
      getByText("Could not load agents.");
    });
    expect(queryByText(/No agents yet/)).toBeNull();
  });
});
