// Regression coverage for an unknown or gate-denied /settings/:section deep
// link: the URL, stage, and col2 nav must re-agree on the first allowed
// section instead of the stage silently rendering a fallback under a URL
// its own nav disagrees with.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";

import type { PrincipalsPage } from "../src/api";
import { BenchProvider } from "../src/bench-context";
import { SettingsRoute } from "../src/pages/settings-page";
import { meKeys, tenantKeys } from "../src/query-client";
import { TestQueryProvider } from "./test-query-provider";

const principalsPage: PrincipalsPage = {
  data: [
    {
      principalId: "principal_1",
      tenantId: "tenant_1",
      tenantName: "ABK Labs",
      tenantSlug: "abk-labs",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

const deniedAccess = {
  people: "denied",
  roles: "denied",
  grants: "denied",
  credentials: "denied",
  memory: "denied",
} as const;

/** A client pre-seeded so both the bench and the settings-access probe are
 * already resolved on first render — deterministic, no real network. */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  client.setQueryData(meKeys.principals, principalsPage);
  client.setQueryData(
    tenantKeys.settingsAccess("tenant_1", "principal_1"),
    deniedAccess,
  );
  return client;
}

describe("SettingsRoute section-id redirect", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function mount(path: string, navigated: string[]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider client={seededClient()}>
          <BenchProvider>
            <SettingsRoute path={path} navigate={(to) => navigated.push(to)} />
          </BenchProvider>
        </TestQueryProvider>,
      );
    });
  }

  test("an unknown section id redirects to the first allowed section", async () => {
    const navigated: string[] = [];
    await mount("/settings/no-such-section", navigated);
    expect(navigated).toEqual(["/settings/account"]);
  });

  test("a gate-denied section id redirects to the first allowed section", async () => {
    const navigated: string[] = [];
    await mount("/settings/people", navigated);
    expect(navigated).toEqual(["/settings/account"]);
  });

  test("an always-allowed section id does not redirect", async () => {
    const navigated: string[] = [];
    await mount("/settings/account", navigated);
    expect(navigated).toEqual([]);
  });
});
