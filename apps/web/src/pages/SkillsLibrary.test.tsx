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

mock.module("react-router", () => ({
  useNavigate: () => mock(() => {}),
}));

import { SkillsLibrary } from "./SkillsLibrary";

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const skills = [
  {
    id: "skill-1",
    name: "asap",
    displayName: "ASAP",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    scope: "tenant",
    accessTenantId: "tenant-root",
    ownerUserId: "usr-1",
    ownerName: "Ada Lovelace",
  },
  {
    id: "skill-2",
    name: "private-one",
    displayName: "Private One",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    scope: "private",
    accessTenantId: "tenant-1",
    ownerUserId: "usr-2",
    ownerName: "Grace Hopper",
  },
];

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/");
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/skills/share-targets")) {
      return Promise.resolve(
        jsonResponse({
          targets: [{ tenantId: "tenant-root", name: "Corbits" }],
        }),
      );
    }
    if (String(url).includes("/skills")) {
      return Promise.resolve(jsonResponse({ skills }));
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SkillsLibrary),
    ),
  );
}

describe("SkillsLibrary", () => {
  it("shows owner and a resolved access label per skill", async () => {
    renderPage();

    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.body.textContent).toContain("Corbits");
  });

  it("labels private skills as Private", async () => {
    renderPage();

    await waitFor(() =>
      expect(document.body.textContent).toContain("Private One"),
    );
    expect(document.body.textContent).toContain("Grace Hopper");
    expect(document.body.textContent).toContain("Private");
  });
});
