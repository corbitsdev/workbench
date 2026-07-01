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

const ownedTemplate = {
  id: "gtpl_owned",
  version: 1,
  name: "Owned Deck",
  gammaId: "owned123",
  description: "I own this",
  authorId: "prn_me",
  canManage: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const foreignTemplate = {
  id: "gtpl_foreign",
  version: 1,
  name: "Shared Deck",
  gammaId: "foreign456",
  description: "Someone else's",
  authorId: "prn_other",
  canManage: false,
  createdAt: "2026-01-01T00:00:00.000Z",
};

// Routes a request to the right canned response based on URL + method, so the
// page's tool-detail and gamma-templates queries each get what they expect.
const members = [
  { id: "prn_me", name: "Test User" },
  { id: "prn_other", name: "Other Person" },
];

function makeFetch(
  templates: unknown[],
  onMutate?: (url: string, init: RequestInit) => void,
) {
  return mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/tools/")) {
      return Promise.resolve(jsonResponse({ tool: gammaTool }));
    }
    if (url.includes("/members")) {
      return Promise.resolve(jsonResponse({ members }));
    }
    if (url.includes("/gamma-templates")) {
      if (method !== "GET") {
        onMutate?.(url, init as RequestInit);
        return Promise.resolve(jsonResponse({ ok: true }, 200));
      }
      return Promise.resolve(jsonResponse(templates));
    }
    return Promise.resolve(jsonResponse({}, 404));
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

// Resolves an input by its visible <label> text via the htmlFor/id association
// (the form uses explicit association, not aria-label — see FIX 10).
function getInputByLabel(text: string): HTMLInputElement {
  const label = Array.from(document.querySelectorAll("label")).find(
    (l) => l.textContent === text,
  );
  if (!label) throw new Error(`No label with text "${text}"`);
  const forId = label.getAttribute("for");
  const input = forId ? document.getElementById(forId) : null;
  if (!input) throw new Error(`No input associated with label "${text}"`);
  return input as HTMLInputElement;
}

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

describe("SettingsToolDetail (gamma)", () => {
  it("shows Edit and Delete for a template the caller can manage", async () => {
    globalThis.fetch = makeFetch([ownedTemplate]) as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Owned Deck"),
    );
    expect(document.body.textContent).toContain("Edit");
    expect(document.body.textContent).toContain("Delete");
  });

  it("shows a read-only indicator and no Edit/Delete for an unmanageable template", async () => {
    globalThis.fetch = makeFetch([foreignTemplate]) as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Shared Deck"),
    );
    expect(document.body.textContent).toContain("Managed by another member");
    expect(document.body.textContent).not.toContain("Edit");
    expect(document.body.textContent).not.toContain("Delete");
  });

  it("does not delete on a single click — it requires confirmation first", async () => {
    const captured: { deleteUrl: string } = { deleteUrl: "" };
    globalThis.fetch = makeFetch([ownedTemplate], (url, init) => {
      if (init.method === "DELETE") captured.deleteUrl = url;
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Owned Deck"),
    );
    const btn = (label: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      );

    // First click only arms the confirmation; nothing is sent.
    await user.click(btn("Delete") as HTMLButtonElement);
    expect(document.body.textContent).toContain("Confirm delete?");
    expect(captured.deleteUrl).toBe("");

    // Confirming sends the DELETE.
    await user.click(btn("Confirm delete") as HTMLButtonElement);
    await waitFor(() => expect(captured.deleteUrl).not.toBe(""));
    expect(captured.deleteUrl).toContain("/gamma-templates/gtpl_owned");
  });

  it("POSTs a new template through the create form", async () => {
    let createBody: unknown = null;
    globalThis.fetch = makeFetch([], (url, init) => {
      if (init.method === "POST" && !url.includes("/delegates")) {
        createBody = JSON.parse(init.body as string);
      }
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("No templates yet"),
    );
    const btn = (label: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;

    await user.click(btn("New template"));
    await user.type(getInputByLabel("Name"), "Brand New");
    await user.type(getInputByLabel("Gamma template ID"), "new789");
    await user.type(getInputByLabel("Description"), "A shiny new deck");
    await user.click(btn("Create template"));
    await waitFor(() => expect(createBody).not.toBeNull());
    expect(createBody).toEqual({
      name: "Brand New",
      gammaId: "new789",
      description: "A shiny new deck",
    });
  });

  it("keeps Create disabled until name, gammaId, and description are all provided", async () => {
    let created = false;
    globalThis.fetch = makeFetch([], (url, init) => {
      if (init.method === "POST" && !url.includes("/delegates")) created = true;
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("No templates yet"),
    );
    const btn = (label: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;

    await user.click(btn("New template"));
    // Name + gammaId only — description still blank, so the server would 400.
    await user.type(getInputByLabel("Name"), "Brand New");
    await user.type(getInputByLabel("Gamma template ID"), "new789");
    expect(btn("Create template").disabled).toBe(true);
    await user.click(btn("Create template"));
    expect(created).toBe(false);

    // Adding a description enables submission.
    await user.type(getInputByLabel("Description"), "now valid");
    expect(btn("Create template").disabled).toBe(false);
  });

  it("delegates manage access to a teammate chosen by name", async () => {
    const captured: { url: string; body: unknown } = { url: "", body: null };
    globalThis.fetch = makeFetch([ownedTemplate], (url, init) => {
      if (init.method === "POST" && url.includes("/delegates")) {
        captured.url = url;
        captured.body = JSON.parse(init.body as string);
      }
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Owned Deck"),
    );
    const btn = (label: string) =>
      Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent === label,
      ) as HTMLButtonElement;

    await user.click(btn("Share"));
    // The picker resolves teammate names to principal ids.
    const select = await waitFor(() => {
      const el = document.querySelector("select");
      if (!el) throw new Error("no select yet");
      if (!el.textContent?.includes("Other Person"))
        throw new Error("members not loaded");
      return el as HTMLSelectElement;
    });
    await user.selectOptions(select, "prn_other");
    await user.click(btn("Grant access"));
    await waitFor(() => expect(captured.body).not.toBeNull());
    expect(captured.url).toContain("/gamma-templates/gtpl_owned/delegates");
    expect(captured.body).toEqual({ principalId: "prn_other" });
  });

  it("shows the tool description and provider as deep-link context", async () => {
    globalThis.fetch = makeFetch([]) as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Generate a gamma deck."),
    );
    expect(document.body.textContent).toContain("gamma");
  });

  it("navigates back to /settings, staying in context", async () => {
    globalThis.fetch = makeFetch([]) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Templates"),
    );
    const back = Array.from(document.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Settings"),
    );
    await user.click(back as HTMLButtonElement);
    expect(navigateSpy).toHaveBeenCalledWith("/settings");
  });
});

describe("SettingsToolDetail (non-gamma)", () => {
  it("shows the graceful no-settings state", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/tools/")) {
        return Promise.resolve(
          jsonResponse({
            tool: { ...gammaTool, providerName: "attio", name: "attio_query" },
          }),
        );
      }
      return Promise.resolve(jsonResponse([]));
    }) as unknown as typeof fetch;
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "No additional settings for this tool.",
      ),
    );
  });
});
