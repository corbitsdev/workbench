/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Task } from "@workbench/shared";

import { TaskAssigneePicker } from "./TaskAssigneePicker";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const MEMBERS = [
  { id: "principal-1", name: "Alice", refId: "u1" },
  { id: "principal-2", name: "Bob", refId: "u2" },
];

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    createdByPrincipalId: "principal-1",
    title: "Follow up with Acme",
    status: "open",
    source: "user",
    links: [],
    externalRefs: [],
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:00:00.000Z",
    ...over,
  };
}

function renderPicker(
  task: Task,
  opts: { tenantId?: string | null; myPrincipalId?: string | null } = {},
) {
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
      React.createElement(TaskAssigneePicker, {
        task,
        tenantId: opts.tenantId ?? "tenant-1",
        myPrincipalId: opts.myPrincipalId ?? "principal-1",
      }),
    ),
  );
}

function mockFetchOk(patched: { value: unknown }) {
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    if (url.includes("/members")) {
      return Promise.resolve(jsonResponse({ members: MEMBERS }));
    }
    if (url.includes("/me/tasks/task-1") && init?.method === "PATCH") {
      patched.value = JSON.parse((init.body as string) ?? "{}");
      return Promise.resolve(
        jsonResponse(makeTask({ assigneePrincipalId: "principal-2" })),
      );
    }
    return Promise.resolve(jsonResponse({}, 404));
  }) as unknown as typeof fetch;
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("TaskAssigneePicker", () => {
  it("renders nothing for a non-owner viewer when no assignee is set", () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/members")) {
        return Promise.resolve(jsonResponse({ members: MEMBERS }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;
    renderPicker(makeTask(), { myPrincipalId: "principal-2" });
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows a read-only label for a non-owner viewer when an assignee is set", async () => {
    globalThis.fetch = mock((url: string) => {
      if (url.includes("/members")) {
        return Promise.resolve(jsonResponse({ members: MEMBERS }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;
    renderPicker(makeTask({ assigneePrincipalId: "principal-2" }), {
      myPrincipalId: "principal-2",
    });
    await waitFor(() =>
      screen.getByText(
        (_content, element) =>
          element?.tagName.toLowerCase() === "span" &&
          element.textContent === "Assigned to Bob",
      ),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers an Assign control to the owner", () => {
    const patched = { value: null };
    mockFetchOk(patched);
    renderPicker(makeTask());
    screen.getByRole("button", { name: "Assign task" });
  });

  it("lets the owner pick a member, which PATCHes assigneePrincipalId", async () => {
    const patched: { value: unknown } = { value: null };
    mockFetchOk(patched);
    const user = userEvent.setup();
    renderPicker(makeTask());

    await user.click(screen.getByRole("button", { name: "Assign task" }));
    await user.click(await screen.findByText("Bob"));

    await waitFor(() =>
      expect(patched.value).toEqual({ assigneePrincipalId: "principal-2" }),
    );
  });

  it("offers Unassign once a task has an assignee, which clears it", async () => {
    const patched: { value: unknown } = { value: null };
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.includes("/members")) {
        return Promise.resolve(jsonResponse({ members: MEMBERS }));
      }
      if (url.includes("/me/tasks/task-1") && init?.method === "PATCH") {
        patched.value = JSON.parse((init.body as string) ?? "{}");
        return Promise.resolve(jsonResponse(makeTask({})));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPicker(makeTask({ assigneePrincipalId: "principal-2" }));

    await user.click(screen.getByRole("button", { name: "Assign task" }));
    await user.click(await screen.findByText("Unassign"));

    await waitFor(() =>
      expect(patched.value).toEqual({ assigneePrincipalId: null }),
    );
  });

  it("shows a plain-language inline error on a failed assignment", async () => {
    globalThis.fetch = mock((url: string, init?: RequestInit) => {
      if (url.includes("/members")) {
        return Promise.resolve(jsonResponse({ members: MEMBERS }));
      }
      if (url.includes("/me/tasks/task-1") && init?.method === "PATCH") {
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderPicker(makeTask());

    await user.click(screen.getByRole("button", { name: "Assign task" }));
    await user.click(await screen.findByText("Bob"));

    await waitFor(() =>
      screen.getByText("Could not update the assignee. Try again."),
    );
  });
});
