/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SendBriefNowButton } from "./SendBriefNowButton";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function renderButton() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SendBriefNowButton),
    ),
  );
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("SendBriefNowButton", () => {
  it("shows pending state while the request is in flight, then success", async () => {
    let resolveFetch: (res: Response) => void = () => {};
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByText("Send my brief now"));
    expect(screen.getByText("Sending…")).toBeDefined();

    resolveFetch(jsonResponse({ status: "started", deploymentId: "dep-1" }));

    await waitFor(() => {
      expect(
        screen.getByText("On its way — check your inbox in a minute."),
      ).toBeDefined();
    });
    expect(screen.getByText("Send my brief now")).toBeDefined();
  });

  it("shows a friendly rate-limited notice on a 429, not a raw error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(jsonResponse({ error: "too soon" }, 429)),
    ) as unknown as typeof fetch;

    const user = userEvent.setup();
    renderButton();

    await user.click(screen.getByText("Send my brief now"));

    await waitFor(() => {
      expect(
        screen.getByText("You just ran one — try again in a few minutes."),
      ).toBeDefined();
    });
    expect(screen.queryByText("too soon")).toBeNull();
  });
});
