// The routine panel (CL-6125, reworked CL-6139): a list view (this
// workbench's routines, a "New routine" row, name · cadence · Active
// toggle) and an editor view (create/edit one routine), navigated inline
// in the canvas column — the back chevron goes list→close, editor→list,
// never a route hop. Every write autosaves and is serialized through one
// queue (`saveState` shows "Saving…"/"Saved"/an honest error). A routine
// created from the panel always targets the conversation it was opened
// beside — that channel's own host agent and its own id as the delivery
// destination — or, with no channel in scope, this workbench's existing
// Myra channel; never a newly minted one.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const toastMock = mock((_message: string) => undefined);
const actualReactUi = await import("@corbits/react-ui");
mock.module("@corbits/react-ui", () => ({
  ...actualReactUi,
  toast: toastMock,
}));

const { BenchProvider } = await import("../src/bench-context");
const { NavigationProvider } = await import("../src/navigation");
const { CanvasAvailabilityProvider } =
  await import("../src/shell/canvas-availability");
const { RoutinePanel } = await import("../src/shell/routine-panel");
const { TestQueryProvider } = await import("./test-query-provider");

const noop = () => undefined;
const realFetch = globalThis.fetch;

const membership = {
  principalId: "prn_1",
  tenantId: "tnt_1",
  tenantName: "Test Bench",
  tenantSlug: "test-bench",
  kind: "user",
  status: "active",
  roles: [],
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let routines: Record<string, unknown>[] = [];
let createdRoutine: Record<string, unknown> | null = null;
let updatedPatches: Record<string, unknown>[] = [];
let createRoutineCalls: Record<string, unknown>[] = [];
let createChannelCalls: Record<string, unknown>[] = [];
let runNowCalls = 0;
let slackConfigured = false;
let networkDelayMs = 0;
let channelAgentsByChannel: Record<
  string,
  { address: string; handle: string; definitionId: string }[]
> = {
  ch_1: [
    { address: "myra_1@wf_1.tnt_1", handle: "myra", definitionId: "wfd_1" },
  ],
};
let chatChannels: Record<string, unknown>[] = [];
let runsByRoutineId: Record<string, Record<string, unknown>[]> = {};
let tasks: Record<string, unknown>[] = [];
let topLevelRuns: Record<string, unknown>[] = [];
let runTraces: Record<string, Record<string, unknown>> = {};

function routineRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "rtn_1",
    name: "Morning digest",
    definitionId: "wfd_1",
    trigger: null,
    scope: "personal",
    input: {},
    enabled: false,
    deliveryChannelId: null,
    consecutiveFailures: 0,
    deadLetteredAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function routeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (networkDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, networkDelayMs));
  }

  if (url.includes("/api/me/principals")) {
    return jsonResponse({ data: [membership], nextCursor: null });
  }
  if (url.includes("/api/channel-tenancies/kinds")) {
    return jsonResponse({ channelTenantIds: [] });
  }
  if (url.includes("/api/deployment-capabilities")) {
    return jsonResponse({ slackConfigured });
  }
  if (url.includes("/workflows/definitions")) {
    return jsonResponse({
      data: [{ id: "wfd_myra", name: "assistant", status: "deployed" }],
      nextCursor: null,
    });
  }
  const agentsMatch = url.match(/\/chat\/channels\/([^/]+)\/agents$/);
  if (agentsMatch) {
    return jsonResponse({
      items: channelAgentsByChannel[agentsMatch[1] as string] ?? [],
    });
  }
  if (
    url.includes("/chat/channels") &&
    url.includes("kind=chat") &&
    method === "GET"
  ) {
    return jsonResponse({ items: chatChannels });
  }
  if (
    url.includes("/chat/channels") &&
    url.includes("kind=channel") &&
    method === "GET"
  ) {
    return jsonResponse({ items: [] });
  }
  if (url.endsWith("/chat/channels") && method === "POST") {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    createChannelCalls.push(body);
    const channel = {
      id: "ch_myra_new",
      title: body["name"],
      kind: "chat",
      pinned: false,
      participants: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    chatChannels = [...chatChannels, channel];
    channelAgentsByChannel = {
      ...channelAgentsByChannel,
      ch_myra_new: [
        {
          address: "myra_2@wf_2.tnt_1",
          handle: "myra",
          definitionId: "wfd_myra",
        },
      ],
    };
    return jsonResponse(channel);
  }
  if (url.includes("/webhook-triggers") && method === "POST") {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    return jsonResponse({
      id: "wht_1",
      tenantId: "tnt_1",
      name: body["name"],
      workflowDefinitionId: body["workflowDefinitionId"],
      inputTemplate: body["inputTemplate"],
      enabled: true,
      createdBy: "prn_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastFiredAt: null,
      secret: "whsec_test",
    });
  }
  if (url.includes("/routines/") && url.endsWith("/run") && method === "POST") {
    runNowCalls += 1;
    return jsonResponse({ runId: "run_1" });
  }
  const runsMatch = url.match(/\/routines\/([^/?]+)\/runs$/);
  if (runsMatch) {
    return jsonResponse({
      items: runsByRoutineId[runsMatch[1] as string] ?? [],
      nextCursor: null,
    });
  }
  if (url.endsWith("/tasks") && method === "GET") {
    return jsonResponse({ items: tasks });
  }
  if (url.includes("/top-level-runs")) {
    return jsonResponse({ data: topLevelRuns, nextCursor: null });
  }
  const traceMatch = url.match(/\/insights\/runs\/([^/]+)\/trace$/);
  if (traceMatch) {
    return jsonResponse(
      runTraces[traceMatch[1] as string] ?? {
        runId: traceMatch[1],
        spans: null,
        absent: "no reader mounted",
      },
    );
  }
  const patchMatch = url.match(/\/routines\/([^/?]+)$/);
  if (patchMatch && method === "PATCH") {
    const patch: Record<string, unknown> = JSON.parse(String(init?.body));
    updatedPatches.push(patch);
    createdRoutine = { ...(createdRoutine ?? routineRecord()), ...patch };
    routines = routines.map((r) =>
      r["id"] === patchMatch[1]
        ? (createdRoutine as Record<string, unknown>)
        : r,
    );
    return jsonResponse(createdRoutine);
  }
  if (patchMatch && method === "GET") {
    return jsonResponse(
      routines.find((r) => r["id"] === patchMatch[1]) ??
        createdRoutine ??
        routineRecord({ enabled: false }),
    );
  }
  if (url.endsWith("/routines") && method === "GET") {
    return jsonResponse({ items: routines });
  }
  if (url.endsWith("/routines") && method === "POST") {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    createRoutineCalls.push(body);
    createdRoutine = routineRecord({
      id: `rtn_${createRoutineCalls.length}`,
      name: body["name"],
      definitionId: body["definitionId"],
      deliveryChannelId: body["deliveryChannelId"] ?? null,
      trigger: body["trigger"] ?? null,
      input: body["input"] ?? {},
    });
    routines = [...routines, createdRoutine];
    return jsonResponse(createdRoutine);
  }
  return Promise.reject(
    new Error(`unrouted fetch in routine-panel test: ${url} ${method}`),
  );
}

describe("RoutinePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let closed: boolean;
  let openedSubjects: Record<string, unknown>[];

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    closed = false;
    openedSubjects = [];
    routines = [];
    createdRoutine = null;
    updatedPatches = [];
    createRoutineCalls = [];
    createChannelCalls = [];
    runNowCalls = 0;
    slackConfigured = false;
    networkDelayMs = 0;
    chatChannels = [];
    runsByRoutineId = {};
    tasks = [];
    topLevelRuns = [];
    runTraces = {};
    channelAgentsByChannel = {
      ch_1: [
        { address: "myra_1@wf_1.tnt_1", handle: "myra", definitionId: "wfd_1" },
      ],
    };
    toastMock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  async function renderPanel(
    subject: Record<string, unknown> | null,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <TestQueryProvider>
          <NavigationProvider navigate={noop}>
            <BenchProvider>
              <CanvasAvailabilityProvider
                allowed
                open
                profile={null}
                artifact={null}
                routine={subject as never}
                focus={false}
                openProfile={noop}
                openArtifact={noop}
                openRoutine={(next) => openedSubjects.push(next as never)}
                toggleFocus={noop}
                close={() => {
                  closed = true;
                }}
              >
                <RoutinePanel />
              </CanvasAvailabilityProvider>
            </BenchProvider>
          </NavigationProvider>
        </TestQueryProvider>,
      );
    });
    await settle();
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  function fieldByLabel(text: string): HTMLElement | undefined {
    const label = [...container.querySelectorAll("label")].find(
      (el) => el.textContent?.trim() === text,
    );
    const id = label?.getAttribute("for");
    return id ? (container.querySelector(`#${id}`) as HTMLElement) : undefined;
  }

  function buttonWithText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === text,
    );
  }

  function openMenu(trigger: HTMLElement | undefined) {
    trigger?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
  }

  function fillAndBlur(el: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter === undefined)
      throw new Error("native value setter unavailable");
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
  }

  describe("shared canvas-pane chrome (CL-6200)", () => {
    test("the list, runs, and editor views all render through the shared CanvasPaneHeader, not a hand-rolled one", async () => {
      await renderPanel({ view: "list" });
      let header = container.querySelector(".shell-canvas-pane-header");
      expect(header).not.toBeNull();
      expect(
        header?.querySelector(".shell-canvas-pane-title")?.textContent,
      ).toBe("Routines");
      expect(header?.querySelector('[aria-label="Back"]')).not.toBeNull();

      await renderPanel({ view: "runs" });
      header = container.querySelector(".shell-canvas-pane-header");
      expect(header).not.toBeNull();
      expect(
        header?.querySelector(".shell-canvas-pane-title")?.textContent,
      ).toBe("Runs");

      await renderPanel({ routineId: null, channelId: "ch_1" });
      header = container.querySelector(".shell-canvas-pane-header");
      expect(header).not.toBeNull();
      expect(
        header?.querySelector(".shell-canvas-pane-title")?.textContent,
      ).toBe("Routine");
    });
  });

  describe("list view", () => {
    test("back chevron on the list view closes the canvas", async () => {
      await renderPanel({ view: "list" });
      const back = container.querySelector('[aria-label="Back"]');
      act(() => (back as HTMLButtonElement).click());
      expect(closed).toBe(true);
    });

    test("lists the workbench's routines with a New routine row above them", async () => {
      routines = [
        routineRecord({
          id: "rtn_a",
          name: "Morning digest",
          trigger: { kind: "daily", hour: 9, minute: 0 },
        }),
        routineRecord({ id: "rtn_b", name: "Weekly report", enabled: true }),
      ];
      await renderPanel({ view: "list" });

      expect(buttonWithText("New routine")).toBeDefined();
      expect(container.textContent).toContain("Morning digest");
      expect(container.textContent).toContain("Weekly report");
      expect(container.textContent).toContain("Daily 09:00");
    });

    test("opened beside a workbench, the list shows only routines delivering there", async () => {
      routines = [
        routineRecord({
          id: "rtn_here",
          name: "Here digest",
          deliveryChannelId: "ch_1",
        }),
        routineRecord({
          id: "rtn_elsewhere",
          name: "Elsewhere digest",
          deliveryChannelId: "ch_other",
        }),
        routineRecord({ id: "rtn_unbound", name: "Unbound digest" }),
      ];
      await renderPanel({ view: "list", channelId: "ch_1" });

      expect(container.textContent).toContain("Here digest");
      expect(container.textContent).not.toContain("Elsewhere digest");
      expect(container.textContent).not.toContain("Unbound digest");
    });

    test("selecting a row opens that routine's editor via openRoutine", async () => {
      routines = [routineRecord({ id: "rtn_a", name: "Morning digest" })];
      await renderPanel({ view: "list" });

      const row = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Morning digest"),
      );
      act(() => row?.click());

      expect(openedSubjects).toContainEqual({ routineId: "rtn_a" });
    });

    test("New routine opens the editor with a null routineId, carrying the channel through", async () => {
      await renderPanel({ view: "list", channelId: "ch_1" });
      act(() => buttonWithText("New routine")?.click());
      expect(openedSubjects).toContainEqual({
        routineId: null,
        channelId: "ch_1",
      });
    });

    test("a routine with no run history shows Idle", async () => {
      routines = [routineRecord({ id: "rtn_a", name: "Morning digest" })];
      await renderPanel({ view: "list" });
      await settle();
      expect(container.textContent).toContain("Idle");
    });

    test("a routine whose latest run succeeded shows Last run OK", async () => {
      routines = [routineRecord({ id: "rtn_a", name: "Morning digest" })];
      runsByRoutineId["rtn_a"] = [
        {
          runId: "run_a",
          triggeredBy: "schedule",
          createdAt: new Date(Date.now() - 120_000).toISOString(),
          run: { status: "completed" },
        },
      ];
      await renderPanel({ view: "list" });
      await settle();
      expect(container.textContent).toContain("Last run OK");
    });

    test("a routine whose latest run failed shows Last run failed", async () => {
      routines = [routineRecord({ id: "rtn_a", name: "Morning digest" })];
      runsByRoutineId["rtn_a"] = [
        {
          runId: "run_a",
          triggeredBy: "schedule",
          createdAt: new Date().toISOString(),
          error: "sidecar unreachable",
          run: { status: "failed" },
        },
      ];
      await renderPanel({ view: "list" });
      await settle();
      expect(container.textContent).toContain("Last run failed");
    });

    test("Run now flips the row to Running now immediately, then renders an inline outcome once the run completes", async () => {
      networkDelayMs = 20;
      routines = [routineRecord({ id: "rtn_a", name: "Morning digest" })];
      runsByRoutineId["rtn_a"] = [];
      await renderPanel({ view: "list" });

      const runButton = buttonWithText("Run now");
      expect(runButton).toBeDefined();
      act(() => {
        runButton?.click();
      });
      // The run "completes" between the click and the panel's poll —
      // the poll (not the click) is what has to notice.
      runsByRoutineId["rtn_a"] = [
        {
          runId: "run_a",
          triggeredBy: "manual",
          createdAt: new Date().toISOString(),
          run: { status: "completed", reply: "All done — 3 items summarized." },
        },
      ];
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(container.textContent).toContain("Running now");

      await settle();
      expect(container.textContent).toContain("All done — 3 items summarized.");
      expect(buttonWithText("Open trace →")).toBeDefined();
    });

    test("a failed run's inline outcome shows the error, styled distinctly from a successful one", async () => {
      networkDelayMs = 10;
      routines = [routineRecord({ id: "rtn_a", name: "Morning digest" })];
      runsByRoutineId["rtn_a"] = [];
      await renderPanel({ view: "list" });
      act(() => {
        buttonWithText("Run now")?.click();
      });
      runsByRoutineId["rtn_a"] = [
        {
          runId: "run_a",
          triggeredBy: "manual",
          createdAt: new Date().toISOString(),
          error: "sidecar unreachable",
          run: { status: "failed" },
        },
      ];
      await settle();

      expect(container.textContent).toContain("sidecar unreachable");
      const errorSpan = [...container.querySelectorAll("span")].find(
        (el) => el.textContent === "sidecar unreachable",
      );
      expect(errorSpan?.className).toContain("danger");
    });

    test("Tasks section lists this workbench's in-flight and recent tasks with the same state chips", async () => {
      tasks = [
        {
          id: "tsk_1",
          definitionId: "def_1",
          channelId: "ch_1",
          agentName: "Myra",
          prompt: "Summarize the week",
          modelPreference: null,
          status: "running",
          runId: "run_1",
          runIds: ["run_1"],
          stepCount: 1,
          resultMailId: null,
          createdAt: new Date().toISOString(),
          completedAt: null,
        },
        {
          id: "tsk_2",
          definitionId: "def_1",
          channelId: "ch_1",
          agentName: "Myra",
          prompt: "Draft the memo",
          modelPreference: null,
          status: "failed",
          runId: "run_2",
          runIds: ["run_2"],
          stepCount: 1,
          resultMailId: null,
          createdAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ];
      await renderPanel({ view: "list" });
      await settle();

      expect(container.textContent).toContain("Tasks");
      expect(container.textContent).toContain("Running now");
      expect(container.textContent).toContain("Last run failed");
      expect(container.textContent).toContain("Failed.");
    });

    test("Tasks empty state says exactly how to verify", async () => {
      await renderPanel({ view: "list" });
      await settle();
      expect(container.textContent).toContain("Run one now to see it here.");
    });
  });

  describe("runs view", () => {
    function runRecord(
      overrides: Partial<Record<string, unknown>> = {},
    ): Record<string, unknown> {
      return {
        id: "run_a",
        definitionId: "wfd_1",
        channelId: "ch_1",
        definitionName: "Myra",
        tenantId: "tnt_1",
        address: "myra_1@wf_1.tnt_1",
        status: "deployed",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
      };
    }

    test("Runs button on the list view opens the runs view", async () => {
      await renderPanel({ view: "list" });
      act(() => buttonWithText("Runs")?.click());
      expect(openedSubjects).toContainEqual({ view: "runs" });
    });

    test("empty state says No runs yet.", async () => {
      await renderPanel({ view: "runs" });
      await settle();
      expect(container.textContent).toContain("No runs yet.");
    });

    test("lists runs and never navigates away", async () => {
      topLevelRuns = [runRecord({ id: "run_a", definitionName: "Myra" })];
      await renderPanel({ view: "runs" });
      await settle();
      expect(container.textContent).toContain("Myra");
    });

    test("clicking a run row shows its trace inline, without navigating", async () => {
      topLevelRuns = [runRecord({ id: "run_a", definitionName: "Myra" })];
      runTraces["run_a"] = {
        runId: "run_a",
        spans: [
          {
            id: "sp_1",
            label: "Plan",
            kind: "tool",
            start: 0,
            end: 100,
            durationMs: 100,
            tokens: null,
            phase: "ok",
            error: null,
            timingSource: "measured",
          },
        ],
      };
      await renderPanel({ view: "runs" });
      await settle();

      const row = [...container.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("Myra"),
      );
      act(() => row?.click());
      await settle();

      expect(container.textContent).toContain("Run trace");
      expect(container.textContent).toContain("Plan");
      expect(closed).toBe(false);
    });

    test("back chevron on the runs view returns to the list", async () => {
      await renderPanel({ view: "runs" });
      const back = container.querySelector('[aria-label="Back"]');
      act(() => (back as HTMLButtonElement).click());
      expect(openedSubjects).toContainEqual({ view: "list" });
    });
  });

  describe("editor view", () => {
    test("back chevron returns to the list, not close — carrying the channel through", async () => {
      await renderPanel({ routineId: null, channelId: "ch_1" });
      const back = container.querySelector('[aria-label="Back"]');
      act(() => (back as HTMLButtonElement).click());
      expect(closed).toBe(false);
      expect(openedSubjects).toContainEqual({
        view: "list",
        channelId: "ch_1",
      });
    });

    test("creating a routine targets the panel's own channel: its host agent, and delivers back into it", async () => {
      await renderPanel({ routineId: null, channelId: "ch_1" });

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(createRoutineCalls[0]?.["definitionId"]).toBe("wfd_1");
      expect(createRoutineCalls[0]?.["deliveryChannelId"]).toBe("ch_1");
      expect(toastMock).toHaveBeenCalled();
    });

    test("no channel in scope: falls back to the workbench's existing Myra channel, never minting a new one", async () => {
      chatChannels = [
        {
          id: "ch_myra",
          title: "Myra",
          kind: "chat",
          pinned: false,
          participants: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ];
      channelAgentsByChannel = {
        ...channelAgentsByChannel,
        ch_myra: [
          {
            address: "myra_9@wf_9.tnt_1",
            handle: "myra",
            definitionId: "wfd_myra",
          },
        ],
      };
      await renderPanel({ routineId: null });

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Nightly summary");
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(createRoutineCalls[0]?.["deliveryChannelId"]).toBe("ch_myra");
      expect(createRoutineCalls[0]?.["definitionId"]).toBe("wfd_myra");
      expect(createChannelCalls).toHaveLength(0);
    });

    test("rapid Name and Instruction blur in the same tick serialize into one create, then one update — never two creates", async () => {
      await renderPanel({ routineId: null, channelId: "ch_1" });

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      const instruction = fieldByLabel(
        "What should this routine do each time it runs?",
      ) as HTMLTextAreaElement;

      const nameSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set as (this: HTMLInputElement, v: string) => void;
      const textareaSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set as (this: HTMLTextAreaElement, v: string) => void;

      act(() => {
        nameSetter.call(name, "Morning digest");
        name.dispatchEvent(new Event("input", { bubbles: true }));
        textareaSetter.call(instruction, "Summarize overnight activity");
        instruction.dispatchEvent(new Event("input", { bubbles: true }));
        // Both fields blur in the same synchronous batch — the exact race
        // the write queue exists to serialize.
        name.dispatchEvent(new Event("focusout", { bubbles: true }));
        instruction.dispatchEvent(new Event("focusout", { bubbles: true }));
      });
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(updatedPatches).toHaveLength(1);
      expect(updatedPatches[0]).toEqual({
        input: { instruction: "Summarize overnight activity" },
      });
    });

    test("shows Saving… while a write is in flight, then Saved", async () => {
      networkDelayMs = 30;
      await renderPanel({ routineId: null, channelId: "ch_1" });
      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set as (this: HTMLInputElement, v: string) => void;

      act(() => {
        setter.call(name, "Morning digest");
        name.dispatchEvent(new Event("input", { bubbles: true }));
        name.dispatchEvent(new Event("focusout", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(container.textContent).toContain("Saving…");
      await settle();
      expect(container.textContent).toContain("Saved");
    });

    test("an honest inline error when the write fails", async () => {
      await renderPanel({ routineId: null });
      // No channelId and no Myra channel exists, and no assistant
      // definition is deployed for this fixture tenant either — the
      // fallback fails honestly rather than silently minting anything.
      const originalDefs = channelAgentsByChannel;
      channelAgentsByChannel = { ...originalDefs, ch_myra_new: [] };

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });

    test("Active toggle is optimistic — flips immediately, before the PATCH resolves", async () => {
      createdRoutine = routineRecord({ enabled: false });
      routines = [createdRoutine];
      await renderPanel({ routineId: "rtn_1" });

      const toggle = container.querySelector(
        '[role="switch"]',
      ) as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      act(() => toggle.click());
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      await settle();
      expect(updatedPatches).toContainEqual({ enabled: true });
    });

    test("Test run is disabled until the routine is saved, then fires the run-once call", async () => {
      await renderPanel({ routineId: null, channelId: "ch_1" });
      expect(buttonWithText("Run now")?.hasAttribute("disabled")).toBe(true);

      act(() => root.unmount());
      container.remove();
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      createdRoutine = routineRecord({ enabled: true });
      routines = [createdRoutine];
      await renderPanel({ routineId: "rtn_1" });

      const savedRunButton = buttonWithText("Run now");
      expect(savedRunButton?.hasAttribute("disabled")).toBe(false);
      await act(async () => {
        savedRunButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(runNowCalls).toBe(1);
    });

    test("the trigger popover lists only honestly-working triggers — Slack hidden when not configured, shown when it is", async () => {
      slackConfigured = false;
      await renderPanel({ routineId: null, channelId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      let items = [...document.querySelectorAll('[role="menuitem"]')].map(
        (el) => el.textContent?.trim(),
      );
      expect(items).toContain("On a schedule ›");
      expect(items).toContain("Granola call notes");
      expect(items).not.toContain("Slack");

      act(() => root.unmount());
      container.remove();
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      slackConfigured = true;
      await renderPanel({ routineId: null, channelId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
        el.textContent?.trim(),
      );
      expect(items).toContain("Slack");
    });

    test("picking a schedule preset commits the trigger in one click — no sub-menu chain", async () => {
      await renderPanel({ routineId: null, channelId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      const onSchedule = [
        ...document.querySelectorAll('[role="menuitem"]'),
      ].find((el) => el.textContent?.includes("On a schedule"));
      act(() => (onSchedule as HTMLElement).click());
      await settle();

      const preset = buttonWithText("Daily 9:00");
      expect(preset).toBeDefined();
      act(() => preset?.click());
      await settle();

      expect(
        updatedPatches.some(
          (p) =>
            (p["trigger"] as { kind: string; hour: number } | undefined)
              ?.kind === "daily" &&
            (p["trigger"] as { hour: number }).hour === 9,
        ) ||
          createRoutineCalls.some(
            (c) =>
              (c["trigger"] as { kind: string } | undefined)?.kind === "daily",
          ),
      ).toBe(true);
      expect(container.textContent).toContain("Daily at 09:00 UTC");
    });
  });
});
