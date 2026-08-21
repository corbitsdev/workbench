// The routine panel (CL-6125, reworked CL-6139, trimmed to editor-only by
// CL-6362): create/edit one routine, inline in the canvas column — the
// back chevron closes the canvas, never a route hop. Browsing/running
// existing routines lives on the global `/routines` page now. Every write
// autosaves and is serialized through one queue (`saveState` shows
// "Saving…"/"Saved"/an honest error). A routine created from the panel
// always targets the conversation it was opened beside — that workbench's
// own host agent and its own id as the delivery destination — or, with no
// workbench in scope, this workbench's existing Myra workbench; never a
// newly minted one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { spyOnReactUiToast } from "./react-ui-toast-mock";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const toastMock = spyOnReactUiToast();

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
let createWorkbenchCalls: Record<string, unknown>[] = [];
let runNowCalls = 0;
let slackConfigured = false;
let networkDelayMs = 0;
let workbenchAgentsByWorkbench: Record<
  string,
  { address: string; handle: string; definitionId: string }[]
> = {
  ch_1: [
    { address: "myra_1@wf_1.tnt_1", handle: "myra", definitionId: "wfd_1" },
  ],
};
let chatWorkbenches: Record<string, unknown>[] = [];
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
    deliveryWorkbenchId: null,
    consecutiveFailures: 0,
    deadLetteredAt: null,
    nextFireAt: null,
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
  if (url.includes("/api/workbench-tenancies/kinds")) {
    return jsonResponse({ workbenchTenantIds: [] });
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
  const agentsMatch = url.match(/\/chat\/workbenches\/([^/]+)\/agents$/);
  if (agentsMatch) {
    return jsonResponse({
      items: workbenchAgentsByWorkbench[agentsMatch[1] as string] ?? [],
    });
  }
  if (
    url.includes("/chat/workbenches") &&
    url.includes("kind=chat") &&
    method === "GET"
  ) {
    return jsonResponse({ items: chatWorkbenches });
  }
  if (
    url.includes("/chat/workbenches") &&
    url.includes("kind=workbench") &&
    method === "GET"
  ) {
    return jsonResponse({ items: [] });
  }
  if (url.endsWith("/chat/workbenches") && method === "POST") {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    createWorkbenchCalls.push(body);
    const workbench = {
      id: "ch_myra_new",
      title: body["name"],
      kind: "chat",
      pinned: false,
      participants: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    chatWorkbenches = [...chatWorkbenches, workbench];
    workbenchAgentsByWorkbench = {
      ...workbenchAgentsByWorkbench,
      ch_myra_new: [
        {
          address: "myra_2@wf_2.tnt_1",
          handle: "myra",
          definitionId: "wfd_myra",
        },
      ],
    };
    return jsonResponse(workbench);
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
      deliveryWorkbenchId: body["deliveryWorkbenchId"] ?? null,
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
    createWorkbenchCalls = [];
    runNowCalls = 0;
    slackConfigured = false;
    networkDelayMs = 0;
    chatWorkbenches = [];
    runsByRoutineId = {};
    tasks = [];
    topLevelRuns = [];
    runTraces = {};
    workbenchAgentsByWorkbench = {
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
    test("the editor view renders through the shared CanvasPaneHeader, not a hand-rolled one", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      const header = container.querySelector(".shell-canvas-pane-header");
      expect(header).not.toBeNull();
      expect(
        header?.querySelector(".shell-canvas-pane-title")?.textContent,
      ).toBe("Routine");
      expect(header?.querySelector('[aria-label="Back"]')).not.toBeNull();
    });

    test("renders nothing when opened with no subject (CL-6362: the panel is editor-only, never a list to fall back to)", async () => {
      await renderPanel(null);
      expect(container.querySelector(".shell-canvas-pane-header")).toBeNull();
      expect(container.querySelector(".shell-routine-pane")).toBeNull();
    });
  });

  describe("editor view", () => {
    test("back chevron closes the canvas (CL-6362: no list view to step back to)", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      const back = container.querySelector('[aria-label="Back"]');
      act(() => (back as HTMLButtonElement).click());
      expect(closed).toBe(true);
    });

    test("creating a routine targets the panel's own workbench: its host agent, and delivers back into it", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(createRoutineCalls[0]?.["definitionId"]).toBe("wfd_1");
      expect(createRoutineCalls[0]?.["deliveryWorkbenchId"]).toBe("ch_1");
      expect(toastMock).toHaveBeenCalled();
    });

    test("no workbench in scope: falls back to the workbench's existing Myra workbench, never minting a new one", async () => {
      chatWorkbenches = [
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
      workbenchAgentsByWorkbench = {
        ...workbenchAgentsByWorkbench,
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
      expect(createRoutineCalls[0]?.["deliveryWorkbenchId"]).toBe("ch_myra");
      expect(createRoutineCalls[0]?.["definitionId"]).toBe("wfd_myra");
      expect(createWorkbenchCalls).toHaveLength(0);
    });

    test("rapid Name and Instruction blur in the same tick serialize into one create, then one update — never two creates", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });

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
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
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
      // No workbenchId and no Myra workbench exists, and no assistant
      // definition is deployed for this fixture tenant either — the
      // fallback fails honestly rather than silently minting anything.
      const originalDefs = workbenchAgentsByWorkbench;
      workbenchAgentsByWorkbench = { ...originalDefs, ch_myra_new: [] };

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
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
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
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
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
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
        el.textContent?.trim(),
      );
      expect(items).toContain("Slack");
    });

    test("picking a schedule preset commits the trigger in one click — no sub-menu chain", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
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
      expect(container.textContent).toContain("At 09:00 (UTC)");
    });
  });
});
