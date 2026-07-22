/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MyraDefaultsPanel } from "./MyraDefaultsPanel";

const variants = [
  {
    id: "chat-sonnet",
    kind: "chat",
    displayName: "Myra Standard",
    model: "claude-sonnet",
    description: "Balanced everyday chat.",
    isDefault: true,
    costTier: "standard",
  },
  {
    id: "chat-opus",
    kind: "chat",
    displayName: "Myra Deep",
    model: "claude-opus",
    description: "Deep reasoning for hard problems.",
    isDefault: false,
    costTier: "premium",
  },
  {
    id: "triage-haiku",
    kind: "triage",
    displayName: "Triage Fast",
    model: "claude-haiku",
    description: "Quick unattended triage.",
    isDefault: true,
    costTier: "standard",
  },
  {
    id: "triage-sonnet",
    kind: "triage",
    displayName: "Triage Thorough",
    model: "claude-sonnet",
    description: "More careful triage.",
    isDefault: false,
    costTier: "standard",
  },
];

type PutCall = { method: string; body: unknown };

const EMPTY_STYLE_AXES = {
  instructionsGlobal: null,
  instructionsChat: null,
  instructionsTriage: null,
  personality: null,
  emojiUse: null,
  uiType: null,
  artifactUsageChat: null,
  artifactUsageTriage: null,
  toolUsageChat: null,
  toolUsageTriage: null,
  skillUsageChat: null,
  skillUsageTriage: null,
  pinnedSkillIds: [],
  disabledCatalogPackages: [],
  disabledToolNames: [],
  toolCatalog: [],
  creativeChat: null,
  thinkingChat: null,
  creativeTriage: null,
  thinkingTriage: null,
};

let preferences: { chat: string | null; triage: string | null } & Record<
  string,
  string | null | string[]
>;
let putCalls: PutCall[];
let putBehavior: "ok" | "reject";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  preferences = { chat: null, triage: null, ...EMPTY_STYLE_AXES };
  putCalls = [];
  putBehavior = "ok";
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/myra/variants")) {
      return Promise.resolve(jsonResponse({ variants }));
    }
    if (u.includes("/me/features")) {
      return Promise.resolve(
        jsonResponse({
          features: [
            { name: "scheduler", enabled: true },
            { name: "triage", enabled: true },
            { name: "tasks-reconciler", enabled: true },
          ],
        }),
      );
    }
    if (u.includes("/myra-preferences")) {
      if (init?.method === "PUT") {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        putCalls.push({ method: "PUT", body });
        if (putBehavior === "reject") {
          return Promise.reject(new Error("save failed"));
        }
        preferences = { ...preferences, ...body };
        return Promise.resolve(jsonResponse(preferences));
      }
      return Promise.resolve(jsonResponse(preferences));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(MyraDefaultsPanel, { tenantId: "tenant-1" }),
    ),
  );
}

function rowFor(name: string): HTMLElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const match = buttons.find((b) => b.textContent?.includes(name));
  if (!match) throw new Error(`No variant row for "${name}"`);
  return match as HTMLElement;
}

describe("MyraDefaultsPanel", () => {
  it("renders both surface groups with each variant's name, model, and description", async () => {
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Myra chat"),
    );
    expect(document.body.textContent).toContain("Inbox automation");

    expect(document.body.textContent).toContain("Myra Standard");
    expect(document.body.textContent).toContain("claude-sonnet");
    expect(document.body.textContent).toContain("Balanced everyday chat.");
    expect(document.body.textContent).toContain("Triage Fast");
    expect(document.body.textContent).toContain("Quick unattended triage.");
  });

  it("shows a cost note on premium-tier variants only", async () => {
    renderPanel();
    await waitFor(() => rowFor("Myra Deep"));
    const premium = rowFor("Myra Deep");
    const standard = rowFor("Myra Standard");
    expect(premium.textContent).toContain("highest cost");
    expect(standard.textContent).not.toContain("highest cost");
  });

  it("renders a terminal prompt instead of a skeleton when no workbench is active", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MyraDefaultsPanel, { tenantId: null }),
      ),
    );
    expect(document.body.textContent).toContain("Select a workbench");
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });

  it("marks the canonical default as selected when the preference is null", async () => {
    renderPanel();
    await waitFor(() => rowFor("Myra Standard"));
    expect(rowFor("Myra Standard").getAttribute("aria-checked")).toBe("true");
    expect(rowFor("Myra Deep").getAttribute("aria-checked")).toBe("false");
    expect(rowFor("Triage Fast").getAttribute("aria-checked")).toBe("true");
  });

  it("PUTs the pinned id when a non-default variant is chosen", async () => {
    renderPanel();
    await waitFor(() => rowFor("Myra Deep"));
    fireEvent.click(rowFor("Myra Deep"));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({ chat: "chat-opus" });
    await waitFor(() =>
      expect(rowFor("Myra Deep").getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("PUTs null when the default variant is re-selected", async () => {
    preferences = { chat: "chat-opus", triage: null, ...EMPTY_STYLE_AXES };
    renderPanel();
    await waitFor(() =>
      expect(rowFor("Myra Deep").getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(rowFor("Myra Standard"));
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({ chat: null });
  });

  it("hides the inbox-automation group when the triage feature is off", async () => {
    globalThis.fetch = mock((url: string, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/myra/variants")) {
        return Promise.resolve(jsonResponse({ variants }));
      }
      if (u.includes("/me/features")) {
        return Promise.resolve(
          jsonResponse({
            features: [
              { name: "scheduler", enabled: true },
              { name: "triage", enabled: false },
              { name: "tasks-reconciler", enabled: true },
            ],
          }),
        );
      }
      if (u.includes("/myra-preferences")) {
        return Promise.resolve(jsonResponse(preferences));
      }
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Myra chat"),
    );
    expect(document.body.textContent).not.toContain("Inbox automation");
    expect(document.body.textContent).not.toContain("Triage Fast");
    expect(document.body.textContent).toContain("Myra Standard");
  });

  it("shows an inline error and reverts the selection when the save fails", async () => {
    putBehavior = "reject";
    renderPanel();
    await waitFor(() => rowFor("Myra Deep"));
    fireEvent.click(rowFor("Myra Deep"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't save"),
    );
    // Reverted: the default is selected again, the failed pick is not.
    expect(rowFor("Myra Standard").getAttribute("aria-checked")).toBe("true");
    expect(rowFor("Myra Deep").getAttribute("aria-checked")).toBe("false");
  });
});
