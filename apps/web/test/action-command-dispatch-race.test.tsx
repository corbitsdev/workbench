// Regression test for the off-route create-dialog race: firing a palette
// action command ("New skill") from a page other than its target route used
// to dispatch the shared "create" event synchronously, then navigate — but
// the target page's window-event listener only registers once it mounts,
// which happens on the next render after navigate's setState. The event
// fired and was gone before anyone was listening.
//
// runActionCommand now goes through a pending-flag (pending-dialog-request.ts,
// the same pattern library-upload.ts already used for "Upload artifact"):
// off-route, it records the flag and navigates; the target page consumes it
// on mount instead of relying on a same-tick dispatch.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  resetPendingDialogRequests,
  runActionCommand,
} from "../src/command-palette-actions";
import { SkillsPage } from "../src/pages/skills-page";
import { resetSessionSkills } from "../src/skills-session";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  resetSessionSkills();
  resetPendingDialogRequests();
});

describe("runActionCommand off-route dispatch ordering", () => {
  test("new-skill fired from another page opens the create dialog once SkillsPage mounts", async () => {
    // Palette invoked while on /library; SkillsPage is not mounted yet, so
    // no listener exists for "workbench:skills:create" the instant the
    // command runs.
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
        toggleCol2: () => undefined,
      });
    });
    expect(navigated).toEqual(["/skills"]);

    // Only now (mirroring main.tsx's setState-based navigate re-rendering
    // the route switch on the next tick) does SkillsPage actually mount.
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<SkillsPage />);
    });

    // The create dialog (Radix, portaled to document.body) should have
    // opened as a result of the pending flag SkillsPage consumed on mount.
    expect(document.body.textContent).toContain("Create skill");
  });
});
