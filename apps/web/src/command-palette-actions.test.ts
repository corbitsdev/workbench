import { afterEach, describe, expect, test } from "bun:test";

import {
  ACTION_COMMANDS,
  consumePendingNewSkill,
  resetPendingDialogRequests,
  runActionCommand,
} from "./command-palette-actions";
import { resetPendingLibraryUpload } from "./library-upload";
import { NEW_WORKBENCH_PATH } from "./routes";

const realFetch = globalThis.fetch;

afterEach(() => {
  resetPendingDialogRequests();
  resetPendingLibraryUpload();
  globalThis.fetch = realFetch;
});

function context(overrides: {
  readonly path: string;
  readonly navigated?: string[];
  readonly tenantId?: string | null;
}) {
  const navigated: string[] = overrides.navigated ?? [];
  const dispatched: string[] = [];
  let themeCycled = false;
  let canvasClosed = false;
  const listener = (event: Event) => dispatched.push(event.type);
  for (const type of ["workbench:skills:create", "workbench:tasks:create"]) {
    window.addEventListener(type, listener);
  }
  const ctx = {
    path: overrides.path,
    navigate: (to: string) => navigated.push(to),
    tenantId: overrides.tenantId !== undefined ? overrides.tenantId : "tenant-1",
    cycleTheme: () => {
      themeCycled = true;
    },
    closeCanvas: () => {
      canvasClosed = true;
    },
  };
  return {
    ctx,
    navigated,
    dispatched,
    themeCycled: () => themeCycled,
    canvasClosed: () => canvasClosed,
  };
}

describe("ACTION_COMMANDS", () => {
  test("does not include New thread — killed by owner decision", () => {
    const ids: readonly string[] = ACTION_COMMANDS.map((c) => c.id);
    expect(ids.includes("new-thread")).toBe(false);
  });

  test("every command has a stable id, title, and subtitle", () => {
    for (const command of ACTION_COMMANDS) {
      expect(command.id.length).toBeGreaterThan(0);
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.subtitle.length).toBeGreaterThan(0);
    }
  });

  test("exactly one New workbench create row — no duplicate title+destination", () => {
    const newWorkbenchRows = ACTION_COMMANDS.filter((c) => c.title === "New workbench");
    expect(newWorkbenchRows).toHaveLength(1);
    expect(newWorkbenchRows[0]?.id).toBe("new-workbench");

    const titleCounts = new Map<string, number>();
    for (const command of ACTION_COMMANDS) {
      titleCounts.set(command.title, (titleCounts.get(command.title) ?? 0) + 1);
    }
    for (const [title, count] of titleCounts) {
      expect(count, `duplicate title: ${title}`).toBe(1);
    }
  });

  test("new-workbench speaks consumer language, not mint", () => {
    const workbench = ACTION_COMMANDS.find((c) => c.id === "new-workbench");
    expect(workbench?.title).toBe("New workbench");
    expect(workbench?.subtitle).toBe("Start a new workbench");
    expect(workbench?.subtitle.toLowerCase()).not.toContain("mint");
  });

  test("labels 'New skill' to match the app's authoring model, not 'Install skill'", () => {
    const skillCommand = ACTION_COMMANDS.find((c) => c.id === "new-skill");
    expect(skillCommand?.title).toBe("New skill");
  });
});

describe("runActionCommand", () => {
  test("new-workbench opens the template picker — no dialog, no pending flag, no instant mint", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-workbench", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual([NEW_WORKBENCH_PATH]);
  });

  test("new-skill off-route navigates and records a pending flag instead of dispatching", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-skill", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/skills"]);
    expect(consumePendingNewSkill()).toBe(true);
  });

  test("upload-artifact navigates to /artifacts when off-route", async () => {
    const { ctx, navigated } = context({ path: "/agents" });
    await runActionCommand("upload-artifact", ctx);
    expect(navigated).toEqual(["/artifacts"]);
  });

  test("upload-artifact does not navigate when already on /artifacts", async () => {
    const { ctx, navigated } = context({ path: "/artifacts" });
    await runActionCommand("upload-artifact", ctx);
    expect(navigated).toEqual([]);
  });

  test("toggle-theme calls cycleTheme", async () => {
    const { ctx, themeCycled } = context({ path: "/" });
    await runActionCommand("toggle-theme", ctx);
    expect(themeCycled()).toBe(true);
  });

  test("close-canvas calls closeCanvas", async () => {
    const { ctx, canvasClosed } = context({ path: "/" });
    await runActionCommand("close-canvas", ctx);
    expect(canvasClosed()).toBe(true);
  });

  test("go-workbenches navigates to /c", async () => {
    const { ctx, navigated } = context({ path: "/agents" });
    await runActionCommand("go-workbenches", ctx);
    expect(navigated).toEqual(["/w"]);
  });

  test("go-insights navigates to /insights", async () => {
    const { ctx, navigated } = context({ path: "/" });
    await runActionCommand("go-insights", ctx);
    expect(navigated).toEqual(["/insights"]);
  });
});
