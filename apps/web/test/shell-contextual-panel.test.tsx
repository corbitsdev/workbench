// After Chat and Approvals leave the rail, the dock that still needs a live
// DOM check is the bench switcher: it must show the server-resolved bench
// name (via membershipDisplay) once memberships resolve — never a tenant id.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { Rail } from "../src/shell/rail";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let originalFetch: typeof fetch;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
  globalThis.fetch = originalFetch;
});

function stubMemberships(): void {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/me/principals") {
      return jsonResponse({
        data: [
          {
            principalId: "prn_1",
            tenantId: "tnt_1",
            tenantName: "Growth Team Bench",
            tenantSlug: "growth-team",
            kind: "user",
            status: "active",
            roles: [],
          },
        ],
        nextCursor: null,
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function renderRail(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={noop}>
          <BenchProvider>
            <Rail path="/" onNavigate={noop} user={user} onSignOut={noop} />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  if (container === null) throw new Error("container not mounted");
  return container;
}

describe("Rail bench switcher", () => {
  test("shows the membership display name once benches resolve", async () => {
    stubMemberships();
    const el = await renderRail();
    expect(el.textContent).toContain("Growth Team Bench");
    expect(el.textContent).not.toContain("tnt_1");
  });

  test("lists the trimmed product nav, not Chat or Approvals", async () => {
    stubMemberships();
    const el = await renderRail();
    for (const label of [
      "Home",
      "Routines",
      "Library",
      "Agents",
      "Skills",
      "Insights",
    ]) {
      expect(el.textContent).toContain(label);
    }
    expect(el.textContent).not.toContain("Chat");
    expect(el.textContent).not.toContain("Approvals");
  });
});
