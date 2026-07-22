/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MyraInstructionsPanel } from "./MyraInstructionsPanel";

type PutCall = { method: string; body: unknown };

const EMPTY_STYLE_AXES = {
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

let preferences: {
  chat: string | null;
  triage: string | null;
  instructionsGlobal: string | null;
  instructionsChat: string | null;
  instructionsTriage: string | null;
} & Record<string, string | null | string[]>;
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
  preferences = {
    chat: null,
    triage: null,
    instructionsGlobal: "Always cite sources.",
    instructionsChat: "Keep chat replies short.",
    instructionsTriage: null,
    ...EMPTY_STYLE_AXES,
  };
  putCalls = [];
  putBehavior = "ok";
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const u = String(url);
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
      React.createElement(MyraInstructionsPanel, { tenantId: "tenant-1" }),
    ),
  );
}

function textareaFor(label: string): HTMLTextAreaElement {
  const el = document.querySelector(`textarea[aria-label="${label}"]`);
  if (!el) throw new Error(`No textarea labeled "${label}"`);
  return el as HTMLTextAreaElement;
}

// user.clear() does not reliably drive a controlled textarea's onChange in
// this bun + happy-dom + React 19 test environment (the DOM `.value` flips
// but no synthetic change event fires) — repeated `{backspace}` via
// `user.type` does, matching this codebase's other controlled-input tests.
async function clearTextarea(
  user: ReturnType<typeof userEvent.setup>,
  el: HTMLTextAreaElement,
): Promise<void> {
  await user.type(el, "{backspace}".repeat(el.value.length));
}

function saveButtonFor(field: string): HTMLElement {
  const el = document.querySelector(`button[data-field="${field}"]`);
  if (!el) throw new Error(`No save button for field "${field}"`);
  return el as HTMLElement;
}

describe("MyraInstructionsPanel", () => {
  it("renders the existing global, chat, and triage instructions", async () => {
    renderPanel();
    await waitFor(() =>
      expect(textareaFor("Global instructions").value).toBe(
        "Always cite sources.",
      ),
    );
    expect(textareaFor("Chat instructions").value).toBe(
      "Keep chat replies short.",
    );
    expect(textareaFor("Inbox automation instructions").value).toBe("");
  });

  it("saves an edited field and PUTs only that field", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => textareaFor("Global instructions"));

    await clearTextarea(user, textareaFor("Global instructions"));
    await user.type(
      textareaFor("Global instructions"),
      "Never make up numbers.",
    );
    await waitFor(() =>
      expect(saveButtonFor("instructionsGlobal").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(saveButtonFor("instructionsGlobal"));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({
      instructionsGlobal: "Never make up numbers.",
    });
  });

  it("clears a field to null when saved empty", async () => {
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => textareaFor("Chat instructions"));

    await clearTextarea(user, textareaFor("Chat instructions"));
    await waitFor(() =>
      expect(saveButtonFor("instructionsChat").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(saveButtonFor("instructionsChat"));

    await waitFor(() => expect(putCalls.length).toBe(1));
    expect(putCalls[0]?.body).toEqual({ instructionsChat: null });
  });

  it("shows an inline error when the save fails", async () => {
    putBehavior = "reject";
    const user = userEvent.setup();
    renderPanel();
    await waitFor(() => textareaFor("Global instructions"));

    await clearTextarea(user, textareaFor("Global instructions"));
    await user.type(
      textareaFor("Global instructions"),
      "Never make up numbers.",
    );
    await waitFor(() =>
      expect(saveButtonFor("instructionsGlobal").hasAttribute("disabled")).toBe(
        false,
      ),
    );
    fireEvent.click(saveButtonFor("instructionsGlobal"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("Couldn't save"),
    );
  });

  it("renders a terminal prompt instead of a skeleton when no workbench is active", () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(MyraInstructionsPanel, { tenantId: null }),
      ),
    );
    expect(document.body.textContent).toContain("Select a workbench");
    expect(document.querySelector(".animate-pulse")).toBeNull();
  });
});
