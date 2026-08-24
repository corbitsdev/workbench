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
      overrides.tenantId === undefined ? "tenant-1" : overrides.tenantId,
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

  test("new-workbench and new-agent speak consumer language, not mint", () => {
    const workbench = ACTION_COMMANDS.find((c) => c.id === "new-workbench");
    const agent = ACTION_COMMANDS.find((c) => c.id === "new-agent");
    expect(workbench?.subtitle).toBe("Start a new workbench with Myra");
    expect(agent?.subtitle).toBe("Start a new workbench with Myra");
    expect(workbench?.subtitle.toLowerCase()).not.toContain("mint");
    expect(agent?.subtitle.toLowerCase()).not.toContain("mint");
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

  test("new-agent is the same entry point as new-workbench — opens the template picker", async () => {
    const { ctx, navigated, dispatched } = context({ path: "/w/abc" });
    await runActionCommand("new-agent", ctx);
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
    let fetches = 0;
    globalThis.fetch = (() => {
      fetches += 1;
      throw new Error("null tenant must not fall back to a default tenant");
    }) as unknown as typeof fetch;
    const { ctx, navigated } = context({ path: "/", tenantId: null });
    expect(ctx.tenantId).toBeNull();
    await runActionCommand("talk-to-myra", ctx);
    expect(navigated).toEqual([]);
    expect(fetches).toBe(0);
  });

  test("talk-to-myra opens the generic agent DM, not a land-hop", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === "string" ? input : new URL(String(input)).pathname;
      if (path.includes("/workflows/definitions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "def-assistant",
                  tenantId: "tenant-1",
                  name: "assistant",
                  currentVersion: "1",
                  status: "deployed",
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  skills: [],
                },
              ],
              nextCursor: null,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      if (path.endsWith("/chat/workbenches") && init?.method === "POST") {
        posts.push({
          path,
          body: JSON.parse(String(init.body)),
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chan-dm-myra",
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
    }) as unknown as typeof fetch;

    const { ctx, navigated } = context({ path: "/" });
    await runActionCommand("talk-to-myra", ctx);

    expect(posts).toEqual([
      {
        path: "/api/tenants/tenant-1/chat/workbenches",
        body: {
          kind: "chat",
          definitionId: "def-assistant",
          reuseExisting: true,
        },
      },
    ]);
    expect(navigated).toEqual(["/w/chan-dm-myra"]);
    expect(navigated).not.toContain("/");
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
