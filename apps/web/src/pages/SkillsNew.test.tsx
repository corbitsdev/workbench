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

const navigateMock = mock(() => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { SkillsNew } from "./SkillsNew";

const originalFetch = globalThis.fetch;
let calls: { url: string; method: string; json?: unknown }[] = [];
let shareTargets: { tenantId: string; name: string }[] = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const createdSkill = {
  id: "skill-1",
  name: "asap",
  displayName: "ASAP",
  createdAt: "2026-06-17T00:00:00.000Z",
  updatedAt: "2026-06-17T00:00:00.000Z",
  scope: "tenant",
  accessTenantId: "tenant-root",
  ownerUserId: "usr-1",
  ownerName: "Test User",
};

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/");
  calls = [];
  // Default: a single shareable tenant (the org) — no real choice to make.
  shareTargets = [{ tenantId: "tenant-1", name: "Corbits" }];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const entry: (typeof calls)[number] = { url: String(url), method };
    if (typeof init?.body === "string") entry.json = JSON.parse(init.body);
    calls.push(entry);
    if (String(url).includes("/skills/share-targets")) {
      return Promise.resolve(jsonResponse({ targets: shareTargets }));
    }
    if (String(url).includes("/skills") && method === "POST") {
      return Promise.resolve(jsonResponse({ skill: createdSkill }));
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
      React.createElement(SkillsNew),
    ),
  );
}

describe("SkillsNew", () => {
  it('hides the access chooser and never offers "Just Me" when there is one tenant', async () => {
    renderPage();
    await waitFor(() =>
      expect(
        document.querySelector('input[placeholder*="Skill name"]'),
      ).not.toBeNull(),
    );
    expect(document.body.textContent).not.toContain(
      "Who can access this skill?",
    );
    expect(document.body.textContent).not.toContain("Just Me");
  });

  it("creates in the single available tenant as a tenant-scoped skill", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(
        document.querySelector('input[placeholder*="Skill name"]'),
      ).not.toBeNull(),
    );

    await user.type(
      document.querySelector(
        'input[placeholder*="Skill name"]',
      ) as HTMLInputElement,
      "My Skill",
    );
    await user.type(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "# heading",
    );
    await user.click(
      [...document.querySelectorAll("button")].find((b) =>
        /save pasted skill/i.test(b.textContent ?? ""),
      ) as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST")).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("tenantId=tenant-1");
    expect(post?.json).toMatchObject({ scope: "tenant", name: "My Skill" });
  });

  it("shows the chooser and sends the chosen tenant when more than one is available", async () => {
    shareTargets = [
      { tenantId: "tenant-wb", name: "My Workbench" },
      { tenantId: "tenant-1", name: "Corbits" },
    ];
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Who can access this skill?"),
    );
    expect(document.body.textContent).not.toContain("Just Me");
    await waitFor(() =>
      expect(document.body.textContent).toContain("Everyone in Corbits"),
    );

    await user.click(
      document.querySelector('input[value="tenant-1"]') as HTMLInputElement,
    );
    await user.type(
      document.querySelector(
        'input[placeholder*="Skill name"]',
      ) as HTMLInputElement,
      "Shared Skill",
    );
    await user.type(
      document.querySelector("textarea") as HTMLTextAreaElement,
      "# heading",
    );
    await user.click(
      [...document.querySelectorAll("button")].find((b) =>
        /save pasted skill/i.test(b.textContent ?? ""),
      ) as HTMLButtonElement,
    );

    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST")).toBe(true),
    );
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toContain("tenantId=tenant-1");
    expect(post?.json).toMatchObject({ scope: "tenant", name: "Shared Skill" });
  });
});
