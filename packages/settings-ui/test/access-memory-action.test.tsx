// CL-6289 follow-up: the Memory section's route guards on `memory:status`,
// a workbench-owned action distinct from Interchange's own resource
// actions — never `memory:read` (nothing grants that) and never one of
// `@corbits/memory`'s own `add`/`search`/`forget`/`purge` (over-granting
// search/mutate authority just to read a settings page). This pins that
// `useTenancyAccess`'s memory probe evaluates the right action, so a
// future edit can't silently drift it back to "read" and reintroduce the
// bug where the Memory section is invisible to every principal.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { useState, useEffect } from "react";

import { useTenancyAccess } from "../src/access";
import type { TenancyAccess } from "../src/access";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function Probe({
  onAccess,
}: {
  readonly onAccess: (a: TenancyAccess) => void;
}) {
  const access = useTenancyAccess("ten_1", "prn_1");
  const [reported, setReported] = useState(false);
  useEffect(() => {
    if (!reported && Object.values(access).every((v) => v !== "loading")) {
      setReported(true);
      onAccess(access);
    }
  }, [access, reported, onAccess]);
  return null;
}

describe("useTenancyAccess", () => {
  test("evaluates memory on the workbench-owned 'status' action, every other resource on 'read'", async () => {
    const requestedActions: Record<string, string> = {};
    globalThis.fetch = (async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        resource: string;
        action: string;
      };
      requestedActions[body.resource] = body.action;
      return new Response(
        JSON.stringify({ effect: "allow", matchingGrants: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    let observed: TenancyAccess | undefined;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<Probe onAccess={(a) => (observed = a)} />);
      });
      await settle();

      expect(requestedActions["memory"]).toBe("status");
      expect(requestedActions["principal"]).toBe("read");
      expect(requestedActions["role"]).toBe("read");
      expect(requestedActions["grant"]).toBe("read");
      expect(requestedActions["credential"]).toBe("read");
      expect(observed?.memory).toBe("allowed");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
