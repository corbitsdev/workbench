// Brand rail checks: product destinations stay on the rail; tenant ids never
// leak as visible text. Bench switching lives outside the brand rail in the
// shell-mock layout (not a rail switcher). Static markup (like rail.test) —
// effects never run, so membership fetches never resolve into the tree.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { RAIL_PRIMARY_ROUTES } from "../src/routes";
import { Rail } from "../src/shell/rail";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;
const user = { id: "user_1", name: "Ada Lovelace", email: "ada@example.com" };

// Effects (and so BenchProvider's fetch) never run under renderToStaticMarkup.
globalThis.fetch = ((_input: RequestInfo | URL, _init?: RequestInit) =>
  Promise.reject(new Error("no network in static rail tests"))) as typeof fetch;

function renderRail(): string {
  return renderToStaticMarkup(
    <TestQueryProvider>
      <NavigationProvider navigate={noop}>
        <BenchProvider>
          <Rail path="/" onNavigate={noop} user={user} onSignOut={noop} />
        </BenchProvider>
      </NavigationProvider>
    </TestQueryProvider>,
  );
}

describe("brand rail", () => {
  test("never shows tenant ids or membership display names", () => {
    const markup = renderRail();
    // Mock brand rail is product destinations + footer chrome only — no bench
    // switcher text that would reintroduce tenant identity on col1.
    expect(markup).not.toContain("tnt_1");
    expect(markup).not.toContain("Growth Team Bench");
    expect(markup).toContain(">Channels</span>");
  });

  test("lists the trimmed product nav, not Chat or Approvals", () => {
    const markup = renderRail();
    for (const route of RAIL_PRIMARY_ROUTES) {
      expect(markup).toContain(`>${route.label}</span>`);
    }
    expect(markup).not.toContain(">Home</span>");
    expect(markup).not.toContain(">Chat</span>");
    expect(markup).not.toContain(">Approvals</span>");
  });
});
