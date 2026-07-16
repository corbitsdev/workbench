/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MyraStylePanel } from "./MyraStylePanel";

// Fixture labels/descriptions mirror the real catalog shape (bare labels, no
// "(default)" suffix — the UI owns the default marker) plus the per-axis
// description subtitle.
const axes = [
  {
    id: "personality",
    label: "Personality",
    description: "How Myra talks to you.",
    defaultOptionId: "teammate",
    options: [
      {
        id: "teammate",
        label: "Teammate",
        description: "A sharp colleague — plain, direct, no filler.",
      },
      { id: "candid", label: "Candid", description: "Blunt and direct." },
    ],
  },
  {
    id: "artifactUsage",
    label: "Artifact usage",
    description: "How readily Myra creates artifacts.",
    defaultOptionId: "default",
    options: [
      {
        id: "default",
        label: "Default",
        description: "Myra's standard judgment.",
      },
      { id: "none", label: "None", description: "Never create artifacts." },
    ],
  },
];

type PutCall = { method: string; body: unknown };

const EMPTY_PREFERENCES = {
  chat: null,
  triage: null,
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
};

let preferences: Record<string, string | null>;
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
  preferences = { ...EMPTY_PREFERENCES };
  putCalls = [];
  putBehavior = "ok";
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/myra/style-axes")) {
      return Promise.resolve(jsonResponse({ axes }));
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
      React.createElement(MyraStylePanel, { tenantId: "tenant-1" }),
    ),
  );
}

function rowFor(name: string): HTMLElement {
  const buttons = Array.from(document.querySelectorAll("button"));
  const match = buttons.find((b) => b.textContent?.includes(name));
  if (!match) throw new Error(`No option row for "${name}"`);
  return match as HTMLElement;
}

describe("MyraStylePanel", () => {
  it("renders a global axis as a single radiogroup and a usage dial split by surface", async () => {
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Personality"),
    );
    expect(document.body.textContent).toContain("Artifact usage");
    expect(document.body.textContent).toContain("Chat");
    expect(document.body.textContent).toContain("Inbox automation");
    expect(document.querySelectorAll('[role="radiogroup"]').length).toBe(3);
  });

  it("marks each axis's default option selected when the preference is null", async () => {
    renderPanel();
    await waitFor(() => rowFor("Teammate"));
    expect(rowFor("Teammate").getAttribute("aria-checked")).toBe("true");
    expect(rowFor("Candid").getAttribute("aria-checked")).toBe("false");
  });

  it("PUTs the option id for a global axis when a non-default option is chosen", async () => {
    renderPanel();
    await waitFor(() => rowFor("Candid"));
    fireEvent.click(rowFor("Candid"));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({ personality: "candid" });
    await waitFor(() =>
      expect(rowFor("Candid").getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("PUTs null when the default option is re-selected", async () => {
    preferences = { ...EMPTY_PREFERENCES, personality: "candid" };
    renderPanel();
    await waitFor(() =>
      expect(rowFor("Candid").getAttribute("aria-checked")).toBe("true"),
    );
    fireEvent.click(rowFor("Teammate"));
    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({ personality: null });
  });

  it("writes the chat-surface field, not the triage one, for the Chat usage-dial group", async () => {
    renderPanel();
    await waitFor(() => rowFor("None"));
    // Two "None" rows render (chat + triage) — click the first (chat) one.
    const noneButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("None"),
    );
    fireEvent.click(noneButtons[0] as HTMLElement);

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({ artifactUsageChat: "none" });
  });

  it("shows an inline error and reverts when the save fails", async () => {
    putBehavior = "reject";
    renderPanel();
    await waitFor(() => rowFor("Candid"));
    fireEvent.click(rowFor("Candid"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't save"),
    );
    expect(rowFor("Teammate").getAttribute("aria-checked")).toBe("true");
    expect(rowFor("Candid").getAttribute("aria-checked")).toBe("false");
  });

  it("renders each axis's description as its subtitle", async () => {
    renderPanel();
    await waitFor(() =>
      expect(document.body.textContent).toContain("How Myra talks to you."),
    );
    expect(document.body.textContent).toContain(
      "How readily Myra creates artifacts.",
    );
  });

  it("marks the default option with exactly one Default badge and no label suffix", async () => {
    renderPanel();
    await waitFor(() => rowFor("Teammate"));
    const teammate = rowFor("Teammate");
    const markers = (teammate.textContent?.match(/Default/g) ?? []).length;
    expect(markers).toBe(1);
    expect(teammate.textContent).not.toContain("(default)");
    expect(rowFor("Candid").textContent).not.toContain("Default");
  });

  it("attributes a failed usage-dial save to the surface sub-group that failed", async () => {
    putBehavior = "reject";
    renderPanel();
    await waitFor(() => rowFor("None"));
    const noneButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("None"),
    );
    // Click the chat-surface None (first radiogroup pair renders Chat first).
    fireEvent.click(noneButtons[0] as HTMLElement);

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't save"),
    );
    const errors = Array.from(document.querySelectorAll("p")).filter((p) =>
      p.textContent?.includes("Couldn't save"),
    );
    expect(errors.length).toBe(1);
    const subGroup = errors[0]?.parentElement;
    expect(subGroup?.textContent).toContain("Chat");
    expect(subGroup?.textContent).not.toContain("Inbox automation");
  });

  it("clears a surface's error after that field next saves successfully", async () => {
    putBehavior = "reject";
    renderPanel();
    await waitFor(() => rowFor("None"));
    const noneButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent?.includes("None"),
    );
    fireEvent.click(noneButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't save"),
    );

    putBehavior = "ok";
    fireEvent.click(noneButtons[0] as HTMLElement);
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("Couldn't save"),
    );
  });

  it("renders a workbench prompt instead of a skeleton when no workbench is active", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MyraStylePanel, { tenantId: null }),
      ),
    );
    expect(document.body.textContent).toContain("Select a workbench");
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });
});
