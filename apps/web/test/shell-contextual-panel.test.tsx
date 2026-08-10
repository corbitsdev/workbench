// Brand rail live-DOM checks: product destinations stay on the rail; tenant
// ids never leak as visible text. Bench switching lives outside the brand rail
// in the shell-mock layout (not a rail switcher).

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
        principals: [{ id: "prin_1", kind: "user", displayName: "Ada" }],
      });
    }
    if (url === "/api/me/memberships") {
      return jsonResponse({
        memberships: [
          {
            tenantId: "tnt_1",
            principalId: "prin_1",
            role: "owner",
            displayName: "Growth Team Bench",
          },
        ],
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
  // Let membership fetches settle so we can assert they do not leak into the rail.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  if (container === null) throw new Error("container missing");
  return container;
}

describe("brand rail (live DOM)", () => {
  test("never shows tenant ids or membership display names", async () => {
    stubMemberships();
    const el = await renderRail();
    // Mock brand rail is product destinations + footer chrome only — no bench
    // switcher text that would reintroduce tenant identity on col1.
    expect(el.textContent).not.toContain("tnt_1");
    expect(el.textContent).not.toContain("Growth Team Bench");
    expect(el.textContent).toContain("Channels");
  });

  test("lists the trimmed product nav, not Chat or Approvals", async () => {
    stubMemberships();
    const el = await renderRail();
    for (const label of [
      "Routines",
      "Library",
      "Agents",
      "Skills",
      "Insights",
    ]) {
      expect(el.textContent).toContain(label);
    }
    expect(el.textContent).not.toContain("Home");
    expect(el.textContent).not.toContain("Chat");
    expect(el.textContent).not.toContain("Approvals");
  });
});
