import { afterEach, describe, expect, test } from "bun:test";

import {
  ACTION_COMMANDS,
  consumePendingNewChannel,
  consumePendingNewRoutine,
  consumePendingNewSkill,
  consumePendingNewTask,
  requestNewRoutine,
  resetPendingDialogRequests,
  runActionCommand,
} from "./command-palette-actions";
import { resetPendingLibraryUpload } from "./library-upload";

afterEach(() => {
  resetPendingDialogRequests();
  resetPendingLibraryUpload();
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
  for (const type of [
    "workbench:chat:new-channel",
    "workbench:agents:create",
    "workbench:routines:create",
    "workbench:skills:create",
    "workbench:tasks:create",
  ]) {
    window.addEventListener(type, listener);
  }
  const ctx = {
    path: overrides.path,
    navigate: (to: string) => navigated.push(to),
    tenantId: overrides.tenantId ?? "tenant-1",
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

  test("labels 'New skill' to match the app's authoring model, not 'Install skill'", () => {
    const skillCommand = ACTION_COMMANDS.find((c) => c.id === "new-skill");
    expect(skillCommand?.title).toBe("New skill");
  });
});

describe("runActionCommand", () => {
  test("new-channel dispatches immediately when already on a channel path", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/c/abc" });
    await runActionCommand("new-channel", ctx);
    expect(dispatched).toContain("workbench:chat:new-channel");
    expect(navigated).toEqual([]);
    expect(consumePendingNewChannel()).toBe(false);
  });

  test("new-channel off-route navigates and records a pending flag instead of dispatching", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-channel", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/c"]);
    expect(consumePendingNewChannel()).toBe(true);
  });

  test("new-agent retargets to the new-workbench flow — the global agents settings tab is gone, and 'Create new agent' mints a fresh workbench", async () => {
    const onChannel = context({ path: "/c/abc" });
    await runActionCommand("new-agent", onChannel.ctx);
    expect(onChannel.navigated).toEqual([]);
    expect(onChannel.dispatched).toContain("workbench:chat:new-channel");

    const elsewhere = context({ path: "/library" });
    await runActionCommand("new-agent", elsewhere.ctx);
    expect(elsewhere.navigated).toEqual(["/c"]);
    expect(elsewhere.dispatched).toEqual([]);
    expect(consumePendingNewChannel()).toBe(true);
  });

  test("new-routine off-route navigates and records a pending flag instead of dispatching", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-routine", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/routines"]);
    expect(consumePendingNewRoutine()).toBe(true);
  });

  test("new-skill off-route navigates and records a pending flag instead of dispatching", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-skill", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/settings/skills"]);
    expect(consumePendingNewSkill()).toBe(true);
  });

  test("new-task dispatches immediately when already on /inbox", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/inbox" });
    await runActionCommand("new-task", ctx);
    expect(dispatched).toContain("workbench:tasks:create");
    expect(navigated).toEqual([]);
    expect(consumePendingNewTask()).toBe(false);
  });

  test("new-task off-route navigates and records a pending flag instead of dispatching", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-task", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/inbox"]);
    expect(consumePendingNewTask()).toBe(true);
  });

  test("upload-artifact navigates to /library when off-route", async () => {
    const { ctx, navigated } = context({ path: "/agents" });
    await runActionCommand("upload-artifact", ctx);
    expect(navigated).toEqual(["/library"]);
  });

  test("upload-artifact does not navigate when already on /library", async () => {
    const { ctx, navigated } = context({ path: "/library" });
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

  test("go-channels navigates to /c", async () => {
    const { ctx, navigated } = context({ path: "/agents" });
    await runActionCommand("go-channels", ctx);
    expect(navigated).toEqual(["/c"]);
  });

  test("go-insights navigates to /insights", async () => {
    const { ctx, navigated } = context({ path: "/" });
    await runActionCommand("go-insights", ctx);
    expect(navigated).toEqual(["/insights"]);
  });

  test("talk-to-myra does nothing without a selected bench", async () => {
    const { ctx, navigated } = context({ path: "/", tenantId: null });
    await runActionCommand("talk-to-myra", ctx);
    expect(navigated).toEqual([]);
  });
});

// Backs the chat composer's `/run` — the same off-route-safe hop
// `runActionCommand("new-routine", …)` uses, but callable from a caller
// with no command-palette `ActionCommandContext` (see chat-page.tsx).
describe("requestNewRoutine", () => {
  test("dispatches immediately when already on Routines", () => {
    const dispatched: string[] = [];
    const listener = () => dispatched.push("workbench:routines:create");
    window.addEventListener("workbench:routines:create", listener);
    const navigated: string[] = [];

    requestNewRoutine({
      alreadyOnRoutines: true,
      navigateToRoutines: () => navigated.push("/routines"),
    });

    window.removeEventListener("workbench:routines:create", listener);
    expect(dispatched).toEqual(["workbench:routines:create"]);
    expect(navigated).toEqual([]);
    expect(consumePendingNewRoutine()).toBe(false);
  });

  test("off-route navigates and records a pending flag instead of dispatching", () => {
    const dispatched: string[] = [];
    const listener = () => dispatched.push("workbench:routines:create");
    window.addEventListener("workbench:routines:create", listener);
    const navigated: string[] = [];

    requestNewRoutine({
      alreadyOnRoutines: false,
      navigateToRoutines: () => navigated.push("/routines"),
    });

    window.removeEventListener("workbench:routines:create", listener);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/routines"]);
    expect(consumePendingNewRoutine()).toBe(true);
  });
});
