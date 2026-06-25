/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

mock.module("@workbench/ui", () => ({
  isTheme: () => false,
  useTheme: () => ({ theme: "system", setTheme: () => {} }),
  useCompactToolActivity: () => ({ compact: false, setCompact: () => {} }),
  useToolSummaryStyle: () => ({ style: "concise", setStyle: () => {} }),
  THEMES: ["system", "light", "dark"],
  THEME_LABELS: { system: "System", light: "Light", dark: "Dark" },
}));

mock.module("@workbench/settings", () => ({
  SettingsPage: () => <div>settings-page</div>,
}));

mock.module("@workbench/agents/browser", () => ({
  summarizeToolCalls: () => "tool summary",
  isToolSummaryStyle: () => false,
  TOOL_SUMMARY_STYLES: ["concise"],
  TOOL_SUMMARY_STYLE_LABELS: { concise: "Concise" },
  TOOL_SUMMARY_PREVIEW_CALLS: [],
}));

import { default as Settings } from "./Settings";

const realFetch = globalThis.fetch;

function stubVersion(body: unknown, ok = true) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/version")) {
      return new Response(JSON.stringify(body), {
        status: ok ? 200 : 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function neverResolvingVersion() {
  globalThis.fetch = ((_input: RequestInfo | URL) =>
    new Promise<Response>(() => {})) as typeof fetch;
}

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/settings");
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

function bodyText() {
  return document.body.textContent ?? "";
}

describe("Settings build version display", () => {
  it("shows the 7-char short SHA from /version", async () => {
    stubVersion({ buildSha: "abc1234def5678" });
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build abc1234"))
        throw new Error("short SHA not rendered");
    });
    // Only the short form, never the full 40-char value.
    expect(bodyText().includes("abc1234def5678")).toBe(false);
  });

  it("shows a loading placeholder while the query is pending", () => {
    neverResolvingVersion();
    renderSettings();
    expect(bodyText().includes("build …")).toBe(true);
  });

  it('shows "build unknown" when the SHA is null (local dev)', async () => {
    stubVersion({ buildSha: null });
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build unknown"))
        throw new Error("unknown not rendered");
    });
  });

  it('shows "build unknown" when /version returns an unexpected shape', async () => {
    stubVersion({ unexpected: "shape" });
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build unknown"))
        throw new Error("unknown not rendered");
    });
  });

  it('shows "build unknown" when the /version request fails', async () => {
    stubVersion({}, false);
    renderSettings();
    await waitFor(() => {
      if (!bodyText().includes("build unknown"))
        throw new Error("unknown not rendered");
    });
  });
});
