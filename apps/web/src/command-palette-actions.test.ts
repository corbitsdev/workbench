import { describe, expect, test } from "bun:test";

import { ACTION_COMMANDS, runActionCommand } from "./command-palette-actions";

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
    expect(ACTION_COMMANDS.some((c) => c.id === "new-thread")).toBe(false);
  });

  test("every command has a stable id, title, and subtitle", () => {
    for (const command of ACTION_COMMANDS) {
      expect(command.id.length).toBeGreaterThan(0);
      expect(command.title.length).toBeGreaterThan(0);
      expect(command.subtitle.length).toBeGreaterThan(0);
    }
  });

  test("labels 'New skill' to match the app's session-local skills model, not 'Install skill'", () => {
    const skillCommand = ACTION_COMMANDS.find((c) => c.id === "new-skill");
    expect(skillCommand?.title).toBe("New skill");
  });
});

describe("runActionCommand", () => {
  test("new-channel dispatches the shared event and navigates off a non-channel path", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-channel", ctx);
    expect(dispatched).toContain("workbench:chat:new-channel");
    expect(navigated).toEqual(["/c"]);
  });

  test("new-channel does not navigate when already on a channel path", async () => {
    const { ctx, navigated } = context({ path: "/c/abc" });
    await runActionCommand("new-channel", ctx);
    expect(navigated).toEqual([]);
  });

  test("new-agent dispatches and navigates only when off /agents", async () => {
    const onAgents = context({ path: "/agents" });
    await runActionCommand("new-agent", onAgents.ctx);
    expect(onAgents.navigated).toEqual([]);

    const elsewhere = context({ path: "/library" });
    await runActionCommand("new-agent", elsewhere.ctx);
    expect(elsewhere.navigated).toEqual(["/agents"]);
  });

  test("new-routine dispatches and navigates only when off /routines", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-routine", ctx);
    expect(dispatched).toContain("workbench:routines:create");
    expect(navigated).toEqual(["/routines"]);
  });

  test("new-skill dispatches and navigates only when off /skills", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-skill", ctx);
    expect(dispatched).toContain("workbench:skills:create");
    expect(navigated).toEqual(["/skills"]);
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

  test("talk-to-myra does nothing without a selected bench", async () => {
    const { ctx, navigated } = context({ path: "/", tenantId: null });
    await runActionCommand("talk-to-myra", ctx);
    expect(navigated).toEqual([]);
  });
});
