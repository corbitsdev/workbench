/// <reference types="bun" />
import "../../test-setup";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OwnerDemos } from "./OwnerDemos";

// Stub `fetch` rather than mock.module the whole hub-api: a partial module mock
// leaks across bun's --isolate boundary and breaks unrelated suites that import
// the real hub-api. Driving the page through its real hub-api → fetch path keeps
// the seam honest and leak-free.
let demosEnabled = false;
let forcedByEnv = false;
const putBodies: unknown[] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  demosEnabled = false;
  forcedByEnv = false;
  putBodies.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/v1/owner/demos")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        putBodies.push(body);
        demosEnabled = body.enabled;
      }
      return new Response(
        JSON.stringify({ enabled: demosEnabled, forcedByEnv }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

function renderPage() {
  render(
    React.createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      React.createElement(OwnerDemos),
    ),
  );
}

describe("OwnerDemos", () => {
  it("offers to Show demos when currently hidden, and enables on click", async () => {
    demosEnabled = false;
    renderPage();
    const button = (await screen.findByRole("button", {
      name: /show/i,
    })) as HTMLButtonElement;
    button.click();
    await waitFor(() => expect(putBodies).toEqual([{ enabled: true }]));
  });

  it("offers to Hide demos when currently visible, and disables on click", async () => {
    demosEnabled = true;
    renderPage();
    const button = (await screen.findByRole("button", {
      name: /hide/i,
    })) as HTMLButtonElement;
    button.click();
    await waitFor(() => expect(putBodies).toEqual([{ enabled: false }]));
  });

  it("warns and disables the toggle when the env override forces demos on", async () => {
    forcedByEnv = true;
    renderPage();
    const button = (await screen.findByRole("button", {
      name: /show|hide/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/SHOW_DEMOS/).textContent).toContain("SHOW_DEMOS");
  });
});
