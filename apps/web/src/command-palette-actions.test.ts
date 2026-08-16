import { afterEach, describe, expect, test } from "bun:test";

import {
  ACTION_COMMANDS,
  consumePendingNewSkill,
  consumePendingNewTask,
  requestNewRoutine,
  requestNewWorkbench,
  resetPendingDialogRequests,
  runActionCommand,
} from "./command-palette-actions";
import { resetPendingLibraryUpload } from "./library-upload";

const realFetch = globalThis.fetch;

afterEach(() => {
  resetPendingDialogRequests();
  resetPendingLibraryUpload();
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stubs the two calls `createAgentAndLaunch` makes: the account's
 * deployed definitions (finds the seeded `assistant`) and `POST
 * /channels` (mints the workbench). Every "new-channel"/"new-agent" test
 * below wires this so `requestNewWorkbench` resolves for real instead of
 * hitting a real network call.
 */
function stubInstantCreate(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/workflows/definitions")) {
      return Promise.resolve(
        json({
          data: [
            {
              id: "wfd_assistant",
              tenantId: "tenant-1",
              name: "assistant",
              currentVersion: "1",
              status: "deployed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        }),
      );
    }
    if (path.endsWith("/chat/channels")) {
      return Promise.resolve(
        json({
          id: "chan_new",
          title: "New Workbench",
          kind: "chat",
          pinned: false,
          participants: [],
        }),
      );
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
}

function context(overrides: {
  readonly path: string;
  readonly navigated?: string[];
  readonly tenantId?: string | null;
}) {
  const navigated: string[] = overrides.navigated ?? [];
  const dispatched: string[] = [];
  let themeCycled = false;
  let canvasClosed = false;
  const openedRoutines: (string | null)[] = [];
  const listener = (event: Event) => dispatched.push(event.type);
  for (const type of ["workbench:skills:create", "workbench:tasks:create"]) {
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
    openRoutine: (subject: { readonly routineId: string | null }) => {
      openedRoutines.push(subject.routineId);
    },
  };
  return {
    ctx,
    navigated,
    dispatched,
    themeCycled: () => themeCycled,
    canvasClosed: () => canvasClosed,
    openedRoutines,
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
  test("new-channel mints a fresh Myra workbench directly — no dialog, no pending flag (CL-6138)", async () => {
    stubInstantCreate();
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-channel", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/c/chan_new"]);
  });

  test("new-agent is the same one creation verb as new-channel — mints a fresh Myra workbench directly", async () => {
    stubInstantCreate();
    const { ctx, navigated, dispatched } = context({ path: "/c/abc" });
    await runActionCommand("new-agent", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/c/chan_new"]);
  });

  test("requestNewWorkbench does nothing without a selected bench", async () => {
    stubInstantCreate();
    const navigated: string[] = [];
    await requestNewWorkbench({
      tenantId: null,
      navigate: (to) => navigated.push(to),
    });
    expect(navigated).toEqual([]);
  });

  test("new-routine navigates to /routines and opens the routine panel synchronously — no pending flag", async () => {
    const { ctx, navigated, openedRoutines } = context({ path: "/library" });
    await runActionCommand("new-routine", ctx);
    expect(navigated).toEqual(["/routines"]);
    expect(openedRoutines).toEqual([null]);
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

// Backs the chat composer's `/run` and the chat header's "Routines" action
// — a caller with no command-palette `ActionCommandContext` (see
// chat-page.tsx). Canvas state lives above every route, so this always
// navigates and opens the panel synchronously — no pending flag, no
// window event, no mount race to guard against.
describe("requestNewRoutine", () => {
  test("navigates to Routines and opens a fresh routine panel", () => {
    const navigated: string[] = [];
    const openedRoutines: (string | null)[] = [];

    requestNewRoutine({
      navigateToRoutines: () => navigated.push("/routines"),
      openRoutine: (subject) => openedRoutines.push(subject.routineId),
    });

    expect(navigated).toEqual(["/routines"]);
    expect(openedRoutines).toEqual([null]);
  });

  test("carries an initial name and instruction through to the opened subject", () => {
    const openedSubjects: {
      readonly routineId: string | null;
      readonly initialName?: string;
      readonly initialInstruction?: string;
    }[] = [];

    requestNewRoutine({
      navigateToRoutines: () => undefined,
      openRoutine: (subject) => openedSubjects.push(subject),
      initialName: "Weekly digest",
      initialInstruction: "Summarize last week's calls",
    });

    expect(openedSubjects).toEqual([
      {
        routineId: null,
        initialName: "Weekly digest",
        initialInstruction: "Summarize last week's calls",
      },
    ]);
  });
});
