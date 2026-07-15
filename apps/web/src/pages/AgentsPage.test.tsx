/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

import { AgentsPage } from "./AgentsPage";

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

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(AgentsPage),
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
    expect(document.body.textContent).toContain("running");
    expect(document.body.textContent).toContain("ins-1@tenant-1.localhost");

    expect(document.body.textContent).toContain("Loop");
    expect(document.body.textContent).toContain("stopped");
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
      "Agents available to you will appear here.",
    );
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
