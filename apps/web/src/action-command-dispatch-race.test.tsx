// Regression: firing a palette action off-route used to dispatch a "create"
// event before the target page's listener mounted. Now it goes through a
// pending-flag (pending-dialog-request.ts) the target page consumes on mount.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { resetPendingDialogRequests, runActionCommand } from "./command-palette-actions";
import { SkillsPage } from "./pages/skills-page";
import { TestQueryProvider } from "./test-query-provider";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  globalThis.fetch = realFetch;
  resetPendingDialogRequests();
});

describe("runActionCommand off-route dispatch ordering", () => {
  test("new-skill fired from another page opens the create dialog once the Skills section mounts", async () => {
    // Palette invoked while on /library; the Skills settings section is not
    // mounted yet, so no listener exists for "workbench:skills:create" the
    // instant the command runs.
    const navigated: string[] = [];
    await act(async () => {
      await runActionCommand("new-skill", {
        path: "/library",
        navigate: (to) => {
          navigated.push(to);
        },
        tenantId: "tenant-1",
        cycleTheme: () => undefined,
        closeCanvas: () => undefined,
      });
    });
    expect(navigated).toEqual(["/skills"]);

    // Serve an empty skill-asset list so the test exercises the
    // pending-flag path, not a network failure.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <SkillsPage tenantId="tenant-1" />
        </TestQueryProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    // The create dialog (Radix, portaled to document.body) should have
    // opened as a result of the pending flag the section consumed on mount.
    expect(document.body.textContent).toContain("Create skill");
  });
});
