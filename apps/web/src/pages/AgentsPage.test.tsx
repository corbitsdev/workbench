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

import { AgentsPage, filterAgentDefinitions, filterAgents } from "./AgentsPage";
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

const templates = [
  {
    key: "oat",
    name: "Oat",
    description: "Shared workspace agent",
    tools: ["gamma", "exa"],
  },
  {
    key: "myra",
    name: "Myra",
    description: "Personal assistant",
    tools: [],
  },
];

const deployedOatInstance = {
  id: "ins-1",
  agentId: "agt-1",
  agentName: "Oat",
  agentDescription: "Shared workspace agent",
  tenantId: "tenant-1",
  address: "ins-1@tenant-1.localhost",
  status: "running",
};

function defaultFetchImpl(url: string): Promise<Response> {
  if (String(url).includes("/agents/templates")) {
    return Promise.resolve(jsonResponse({ data: templates }));
  }
  if (String(url).includes("/agents")) {
    return Promise.resolve(jsonResponse({ data: [] }));
  }
  return Promise.resolve(jsonResponse({}));
}

let fetchImpl: (url: string) => Promise<Response> = defaultFetchImpl;

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/");
  meImpl = () => Promise.resolve(defaultMe);
  fetchImpl = defaultFetchImpl;
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

  it("renders agent definitions from the templates response when no instances are deployed", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("Oat"));
    expect(document.body.textContent).toContain("Shared workspace agent");
    expect(document.body.textContent).toContain("Myra");
    expect(document.body.textContent).toContain("Personal assistant");
    expect(document.body.textContent).toContain("Not deployed");
  });

  it("shows a deployed instance's status and address on its matching definition card", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(jsonResponse({ data: templates }));
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(jsonResponse({ data: [deployedOatInstance] }));
      }
      return Promise.resolve(jsonResponse({}));
    };

    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("Oat"));
    expect(document.body.textContent).toContain("Running");
    expect(document.body.textContent).toContain("ins-1@tenant-1.localhost");

    expect(document.body.textContent).toContain("Myra");
    expect(document.body.textContent).toContain("Not deployed");
  });

  it("exposes a copy control for a deployed instance's mailbox address", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(jsonResponse({ data: templates }));
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(jsonResponse({ data: [deployedOatInstance] }));
      }
      return Promise.resolve(jsonResponse({}));
    };

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

  it("reserves the Add-action slot even though Agents has no add action", async () => {
    const { getByRole } = renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("Oat"));
    const placeholder = getByRole("button", { name: "Add" });
    expect(placeholder.className).toContain("invisible");
    expect(placeholder.getAttribute("tabIndex")).toBe("-1");
  });

  it("filters definitions by name or description", async () => {
    const { getByLabelText, queryByText } = renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("Oat"));

    fireEvent.change(getByLabelText("Search agents"), {
      target: { value: "personal" },
    });

    await waitFor(() => {
      expect(queryByText("Myra")).toBeTruthy();
      expect(queryByText("Oat")).toBeNull();
    });
  });

  it("filterAgentDefinitions matches name or description", () => {
    expect(
      filterAgentDefinitions(templates, "personal").map((t) => t.name),
    ).toEqual(["Myra"]);
    expect(
      filterAgentDefinitions(templates, "shared").map((t) => t.name),
    ).toEqual(["Oat"]);
    expect(filterAgentDefinitions(templates, "zzzz")).toEqual([]);
    expect(filterAgentDefinitions(templates, "  ").map((t) => t.name)).toEqual([
      "Oat",
      "Myra",
    ]);
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

  it("renders every tool in the row/table view - the only surface showing an agent's full tool list", async () => {
    const heavyTools = [
      "firecrawl-scrape",
      "firecrawl-crawl",
      "firecrawl-search",
      "firecrawl-map",
      "firecrawl-extract",
      "firecrawl-batch",
      "firecrawl-status",
      "firecrawl-cancel",
    ];
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                key: "research",
                name: "Research Agent",
                description: "Heavy tool surface",
                tools: heavyTools,
              },
            ],
          }),
        );
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    };

    const { getByRole } = renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Research Agent"),
    );

    fireEvent.click(getByRole("button", { name: "Rows view" }));
    await waitFor(() => {
      expect(document.body.querySelector("table")).toBeTruthy();
    });

    // There is no agent-detail route in the app - the row/table view is the
    // only surface that must show an agent's complete tool list, so it must
    // never be capped the way the card summary is.
    for (const tool of heavyTools) {
      expect(document.body.textContent).toContain(tool);
    }
    expect(document.body.textContent).not.toMatch(/\+\d+ more/);

    // Restore grid view so the persisted view-mode preference doesn't leak
    // into later tests in this file.
    fireEvent.click(getByRole("button", { name: "Grid view" }));
    await waitFor(() => {
      expect(document.body.querySelector("table")).toBeNull();
    });
  });

  it("caps a heavy-tool agent's tool chips on the card instead of rendering all of them", async () => {
    const heavyTools = [
      "firecrawl-scrape",
      "firecrawl-crawl",
      "firecrawl-search",
      "firecrawl-map",
      "firecrawl-extract",
      "firecrawl-batch",
      "firecrawl-status",
    ];
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                key: "research",
                name: "Research Agent",
                description: "Heavy tool surface",
                tools: heavyTools,
              },
            ],
          }),
        );
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    };

    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Research Agent"),
    );
    // Only the first 4 tools render as chips; the rest collapse into a
    // single "+N more" summary instead of inflating the card.
    expect(document.body.textContent).toContain("firecrawl-scrape");
    expect(document.body.textContent).toContain("firecrawl-map");
    expect(document.body.textContent).not.toContain("firecrawl-extract");
    expect(document.body.textContent).not.toContain("firecrawl-batch");
    expect(document.body.textContent).not.toContain("firecrawl-status");
    expect(document.body.textContent).toContain("+3 more");
  });

  it("shows deploy status once on the card - no duplicate 'Not deployed' chip beside the tool list", async () => {
    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("Myra"));

    const notDeployedMatches = (document.body.textContent ?? "").match(
      /Not deployed/g,
    );
    // Two definitions (Oat, Myra) are both undeployed - one "Not deployed"
    // per card (the corner banner), never a second copy in the body.
    expect(notDeployedMatches).toEqual(["Not deployed", "Not deployed"]);
  });

  it("shows all instances when a definition has more than one deployed", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(jsonResponse({ data: templates }));
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              deployedOatInstance,
              {
                id: "ins-2",
                agentId: "agt-1",
                agentName: "Oat",
                agentDescription: "Shared workspace agent",
                tenantId: "tenant-1",
                address: "ins-2@tenant-1.localhost",
                status: "stopped",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    };

    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("ins-1@tenant-1.localhost"),
    );
    // Both instances of the same "Oat" definition must be visible - the
    // second one must not be dropped by a name-keyed single-instance map.
    expect(document.body.textContent).toContain("ins-2@tenant-1.localhost");
    expect(document.body.textContent).toContain("Running");
    expect(document.body.textContent).toContain("Stopped");
  });

  it("filters the orphan section by the same query - no unfiltered table under a 'no results' message", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(jsonResponse({ data: templates }));
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "ins-9",
                agentId: "agt-9",
                agentName: "Retired Agent",
                agentDescription: "No longer a template",
                tenantId: "tenant-1",
                address: "ins-9@tenant-1.localhost",
                status: "stopped",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    };

    const { getByLabelText, queryByText } = renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Retired Agent"),
    );

    // A query matching only the orphan instance, not any definition.
    fireEvent.change(getByLabelText("Search agents"), {
      target: { value: "retired" },
    });

    await waitFor(() => {
      expect(queryByText("Retired Agent")).toBeTruthy();
    });
    expect(queryByText("Oat")).toBeNull();
    expect(queryByText("Myra")).toBeNull();
    expect(document.body.textContent).not.toContain("No results");

    // A query matching neither a definition nor the orphan instance must
    // filter the orphan section out too, not just hide it while unfiltered.
    fireEvent.change(getByLabelText("Search agents"), {
      target: { value: "zzz-no-match" },
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain("No results");
    });
    expect(queryByText("Retired Agent")).toBeNull();
  });

  it("renders unmatched deployed instances in a separate section", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(jsonResponse({ data: templates }));
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(
          jsonResponse({
            data: [
              {
                id: "ins-9",
                agentId: "agt-9",
                agentName: "Retired Agent",
                agentDescription: "No longer a template",
                tenantId: "tenant-1",
                address: "ins-9@tenant-1.localhost",
                status: "stopped",
              },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    };

    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Retired Agent"),
    );
    expect(document.body.textContent).toContain("Deployed instances");
  });

  it("shows an error message when the agents request fails", async () => {
    fetchImpl = () => Promise.reject(new Error("network down"));
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Could not load agents"),
    );
  });

  it("shows the empty state when there are no agent definitions", async () => {
    fetchImpl = (url) => {
      if (String(url).includes("/agents/templates")) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      if (String(url).includes("/agents")) {
        return Promise.resolve(jsonResponse({ data: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    };
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No agent definitions available yet.",
      ),
    );
    expect(document.body.textContent).not.toContain("coming soon");
  });

  it("shows the error state when the identity request fails", async () => {
    meImpl = () => Promise.reject(new Error("me failed"));
    const { getByText, queryByText } = renderPage();
    await waitFor(() => {
      getByText("Could not load agents.");
    });
    expect(queryByText(/No agent definitions/)).toBeNull();
  });

  it("shows the error state, not the empty state, when no personal tenant resolves", async () => {
    meImpl = () => Promise.resolve({ ...defaultMe, personalTenantId: null });
    const { getByText, queryByText } = renderPage();
    await waitFor(() => {
      getByText("Could not load agents.");
    });
    expect(queryByText(/No agent definitions/)).toBeNull();
  });
});
