import { afterEach, describe, expect, test } from "bun:test";

import {
  ACTION_COMMANDS,
  consumePendingNewSkill,
  requestNewRoutine,
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
  const openedRoutines: (string | null)[] = [];
  const listener = (event: Event) => dispatched.push(event.type);
  for (const type of ["workbench:skills:create", "workbench:tasks:create"]) {
    window.addEventListener(type, listener);
  }
  const ctx = {
    path: overrides.path,
    navigate: (to: string) => navigated.push(to),
    tenantId:
      overrides.tenantId !== undefined ? overrides.tenantId : "tenant-1",
    cycleTheme: () => {
      themeCycled = true;
    },
    closeCanvas: () => {
      canvasClosed = true;
    },
    openRoutine: (subject: { readonly routineId?: string | null }) => {
      openedRoutines.push(subject.routineId ?? null);
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

  test("exactly one New workbench create row — no duplicate title+destination (CL-6820)", () => {
    const newWorkbenchRows = ACTION_COMMANDS.filter(
      (c) => c.title === "New workbench",
    );
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
  test("new-workbench opens the template picker — no dialog, no pending flag, no instant mint (CL-6342)", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-workbench", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual([NEW_WORKBENCH_PATH]);
  });

  test("new-routine opens the routine panel synchronously, beside whatever page is showing — no navigation, no pending flag", async () => {
    const { ctx, navigated, openedRoutines } = context({ path: "/library" });
    await runActionCommand("new-routine", ctx);
    expect(navigated).toEqual([]);
    expect(openedRoutines).toEqual([null]);
  });

  test("new-skill off-route navigates and records a pending flag instead of dispatching", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/library" });
    await runActionCommand("new-skill", ctx);
    expect(dispatched).toEqual([]);
    expect(navigated).toEqual(["/skills"]);
    expect(consumePendingNewSkill()).toBe(true);
  });

  test("upload-artifact navigates to /files when off-route", async () => {
    const { ctx, navigated } = context({ path: "/agents" });
    await runActionCommand("upload-artifact", ctx);
    expect(navigated).toEqual(["/files"]);
  });

  test("upload-artifact does not navigate when already on /files", async () => {
    const { ctx, navigated } = context({ path: "/files" });
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

  test("talk-to-myra does nothing without a selected bench", async () => {
    const { ctx, navigated } = context({ path: "/", tenantId: null });
    await runActionCommand("talk-to-myra", ctx);
    expect(navigated).toEqual([]);
  });

  test("talk-to-myra opens Myra's DM via kind=chat + definitionId, not a title-match mint", async () => {
    const calls: { readonly path: string; readonly init?: RequestInit }[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      calls.push(init === undefined ? { path } : { path, init });
      if (path.includes("/workflows/definitions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
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
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (path.endsWith("/chat/workbenches")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chan_myra_dm",
              title: "Myra",
              kind: "chat",
              pinned: false,
              participants: [],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      throw new Error(`unexpected fetch: ${init?.method ?? "GET"} ${path}`);
    }) as typeof fetch;

    const { ctx, navigated } = context({ path: "/" });
    await runActionCommand("talk-to-myra", ctx);

    const createCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches"),
    );
    expect(createCall?.init?.method).toBe("POST");
    expect(JSON.parse(String(createCall?.init?.body))).toEqual({
      kind: "chat",
      definitionId: "wfd_assistant",
      reuseExisting: true,
    });
    expect(navigated).toEqual(["/w/chan_myra_dm"]);
  });
});

// Backs the `>` command palette's "New routine" and "Make this a routine"
// (chat-page.tsx) — a caller with no command-palette
// `ActionCommandContext`. Canvas state lives above every route, so this
// opens the panel synchronously, beside whatever page is already showing
// — no navigation, no pending flag, no window event, no mount race to
// guard against.
describe("requestNewRoutine", () => {
  test("opens a fresh routine panel with no navigation", () => {
    const openedRoutines: (string | null)[] = [];

    requestNewRoutine({
      openRoutine: (subject) => openedRoutines.push(subject.routineId ?? null),
    });

    expect(openedRoutines).toEqual([null]);
  });

  test("carries an initial name and instruction through to the opened subject", () => {
    const openedSubjects: {
      readonly routineId: string | null;
      readonly initialName?: string;
      readonly initialInstruction?: string;
    }[] = [];

    requestNewRoutine({
      openRoutine: (subject) =>
        openedSubjects.push({
          ...subject,
          routineId: subject.routineId ?? null,
        }),
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
