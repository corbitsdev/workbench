/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MySchedules } from "./MySchedules";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const schedule = {
  id: "sch_1",
  workflowKind: "morning-brief",
  hourUtc: 13,
  enabled: true,
  triggerPayload: {},
  createdAt: "2026-01-01T00:00:00.000Z",
};

const catalog = {
  entries: [
    {
      kind: "morning-brief",
      label: "Morning Brief",
      isFavorite: false,
      stepCount: 3,
      pauseCount: 0,
      steps: [],
    },
  ],
};

function makeFetch(
  initial: (typeof schedule)[],
  onMutate?: (url: string, init: RequestInit) => void,
) {
  // Model the server so a post-mutation GET reflects the change instead of
  // masking the optimistic update with stale data.
  let current = [...initial];
  return mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.includes("/me/schedules")) {
      if (method === "GET") return Promise.resolve(jsonResponse(current));
      onMutate?.(url, init as RequestInit);
      const id = url.split("/me/schedules/")[1] ?? "";
      if (method === "DELETE") {
        current = current.filter((s) => s.id !== id);
        return Promise.resolve(jsonResponse(null, 204));
      }
      const patch = JSON.parse((init?.body as string) ?? "{}");
      current = current.map((s) => (s.id === id ? { ...s, ...patch } : s));
      const updated = current.find((s) => s.id === id) ?? schedule;
      return Promise.resolve(jsonResponse(updated, 200));
    }
    if (url.includes("/workflows")) {
      return Promise.resolve(jsonResponse(catalog));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });
}

function renderList() {
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
      React.createElement(MySchedules, { tenantId: "tenant-1" }),
    ),
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("MySchedules", () => {
  it("shows the empty state when the member has no schedules", async () => {
    globalThis.fetch = makeFetch([]) as unknown as typeof fetch;
    renderList();
    await waitFor(() => screen.getByText("No schedules yet"));
  });

  it("renders a schedule with its workflow label resolved from the catalog", async () => {
    globalThis.fetch = makeFetch([schedule]) as unknown as typeof fetch;
    renderList();
    await waitFor(() => screen.getByText("Morning Brief"));
  });

  it("pauses a schedule via PATCH when the switch is toggled", async () => {
    let patch: { url: string; body: unknown } | null = null;
    globalThis.fetch = makeFetch([schedule], (url, init) => {
      if (init.method === "PATCH")
        patch = { url, body: JSON.parse(init.body as string) };
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderList();

    const toggle = await screen.findByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle);
    // Optimistic flip is immediate.
    await waitFor(() =>
      expect(toggle.getAttribute("aria-checked")).toBe("false"),
    );
    await waitFor(() => expect(patch).not.toBeNull());
    expect(patch!.url).toContain("/me/schedules/sch_1");
    expect(patch!.body).toEqual({ enabled: false });
  });

  it("removes a schedule via DELETE after confirmation", async () => {
    let deleteUrl = "";
    globalThis.fetch = makeFetch([schedule], (url, init) => {
      if (init.method === "DELETE") deleteUrl = url;
    }) as unknown as typeof fetch;
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByRole("button", { name: "Remove" }));
    // First click only arms the confirm; no request yet.
    expect(deleteUrl).toBe("");
    await user.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(deleteUrl).not.toBe(""));
    expect(deleteUrl).toContain("/me/schedules/sch_1");
  });
});
