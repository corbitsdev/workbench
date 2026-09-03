// The routine panel (CL-6125, reworked CL-6139, trimmed to editor-only by
// CL-6362; target inference replaced by an explicit picker in CL-7355):
// create/edit one routine, inline in the canvas column — the back chevron
// closes the canvas, never a route hop. Browsing/running existing routines
// lives on the global `/routines` page now. Every write autosaves and is
// serialized through one queue (`saveState` shows "Saving…"/"Saved"/an
// honest error). A routine's delivery destination is the conversation the
// panel was opened beside — its own id, or, with no workbench in scope,
// this workbench's existing Myra workbench; never a newly minted one. What
// the routine *runs* is a separate, explicit pick from
// `GET /api/tenants/:tenantId/workflows/targets` — never inferred from the
// conversation's own agent.

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

type TargetFixture = {
  definitionAssetId: string;
  definitionId: string;
  assetName: string;
  name: string;
  description: string | null;
  kind: "agent" | "workflow";
  wireHash: string;
};

let routines: Record<string, unknown>[] = [];
let createdRoutine: Record<string, unknown> | null = null;
let updatedPatches: Record<string, unknown>[] = [];
let createRoutineCalls: Record<string, unknown>[] = [];
let createWorkbenchCalls: Record<string, unknown>[] = [];
let runNowCalls = 0;
let slackConfigured = false;
let granolaConnected = false;
let capabilitiesProbeFails = false;
let networkDelayMs = 0;
let targets: TargetFixture[] = [
  {
    definitionAssetId: "asset_myra",
    definitionId: "wfd_1",
    assetName: "myra",
    name: "Myra",
    description: "This workbench's own assistant.",
    kind: "agent",
    wireHash: "hash_1",
  },
  {
    definitionAssetId: "asset_digest",
    definitionId: "wfd_2",
    assetName: "digest-workflow",
    name: "Morning digest workflow",
    description: "Summarizes overnight activity.",
    kind: "workflow",
    wireHash: "hash_2",
  },
];
let targetsRequestFails = false;
let patchTargetRejection: { status: number; message: string } | null = null;
let chatWorkbenches: Record<string, unknown>[] = [];
let runsByRoutineId: Record<string, Record<string, unknown>[]> = {};
let topLevelRuns: Record<string, unknown>[] = [];
let runTraces: Record<string, Record<string, unknown>> = {};

function routineRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "rtn_1",
    name: "Morning digest",
    definitionAssetId: "asset_myra",
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
    if (capabilitiesProbeFails) {
      return new Response(JSON.stringify({ message: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }
    return jsonResponse({ slackConfigured });
  }
  if (url.includes("/credentials/resolve/Granola")) {
    if (!granolaConnected) {
      return new Response(null, { status: 404 });
    }
    return jsonResponse({
      id: "cred_granola",
      tenantId: "tnt_1",
      name: "Granola",
      status: "active",
    });
  }
  if (url.includes("/credentials/resolve/")) {
    return new Response(null, { status: 404 });
  }
  if (url.includes("/workflows/targets")) {
    if (targetsRequestFails) {
      return new Response(
        JSON.stringify({ error: { userMessage: "Not authorized." } }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }
    return jsonResponse({ items: targets, nextCursor: null });
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
    if (
      patch["definitionAssetId"] !== undefined &&
      patchTargetRejection !== null
    ) {
      updatedPatches.push(patch);
      return new Response(
        JSON.stringify({
          error: { userMessage: patchTargetRejection.message },
        }),
        {
          status: patchTargetRejection.status,
          headers: { "content-type": "application/json" },
        },
      );
    }
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
      definitionAssetId: body["definitionAssetId"],
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
    granolaConnected = false;
    capabilitiesProbeFails = false;
    networkDelayMs = 0;
    targetsRequestFails = false;
    patchTargetRejection = null;
    targets = [
      {
        definitionAssetId: "asset_myra",
        definitionId: "wfd_1",
        assetName: "myra",
        name: "Myra",
        description: "This workbench's own assistant.",
        kind: "agent",
        wireHash: "hash_1",
      },
      {
        definitionAssetId: "asset_digest",
        definitionId: "wfd_2",
        assetName: "digest-workflow",
        name: "Morning digest workflow",
        description: "Summarizes overnight activity.",
        kind: "workflow",
        wireHash: "hash_2",
      },
    ];
    chatWorkbenches = [];
    runsByRoutineId = {};
    topLevelRuns = [];
    runTraces = {};
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

  function selectTarget(definitionAssetId: string) {
    const select = container.querySelector(
      "#routine-panel-target",
    ) as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype,
      "value",
    )?.set;
    if (setter === undefined)
      throw new Error("native value setter unavailable");
    act(() => {
      setter.call(select, definitionAssetId);
      select.dispatchEvent(new Event("change", { bubbles: true }));
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

    // CL-7355: no target is ever inferred from the conversation's own
    // agent — typing a name and blurring with no target picked must not
    // create anything.
    test("no target is inferred from chat participants: naming a routine with nothing picked never creates", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(createRoutineCalls).toHaveLength(0);
    });

    // The bail-out above must not be a silent no-op: a person who blurs
    // with nothing picked sees an inline hint, not just an absent network
    // call.
    test("blurring with no target picked shows a visible hint, which clears once a target is picked", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(container.textContent).toContain(
        "Pick what this routine runs before the rest can save.",
      );

      selectTarget("asset_digest");
      await settle();

      expect(container.textContent).not.toContain(
        "Pick what this routine runs before the rest can save.",
      );
    });

    test("picking a target, then naming the routine, creates with the picked definitionAssetId", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();

      selectTarget("asset_digest");
      await settle();

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(createRoutineCalls[0]?.["definitionAssetId"]).toBe("asset_digest");
      expect(createRoutineCalls[0]?.["deliveryWorkbenchId"]).toBe("ch_1");
      expect(toastMock).toHaveBeenCalled();
    });

    test("groups targets by kind (Agents / Workflows) and lists both", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();

      const select = container.querySelector(
        "#routine-panel-target",
      ) as HTMLSelectElement;
      const groupLabels = [...select.querySelectorAll("optgroup")].map(
        (group) => group.getAttribute("label"),
      );
      expect(groupLabels).toEqual(["Agents", "Workflows"]);
      const optionLabels = [...select.querySelectorAll("option")].map(
        (option) => option.textContent,
      );
      expect(optionLabels).toContain("Myra");
      expect(optionLabels).toContain("Morning digest workflow");
    });

    test("no target is preselected — the picker opens with nothing chosen", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      const select = container.querySelector(
        "#routine-panel-target",
      ) as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    // CL-7356: `/routine`'s (and the palette action's) optional
    // preselection — computed upstream from the conversation's own agent
    // participants — is carried on the subject and shown visibly here,
    // never inferred by the panel itself.
    test("a subject with no preselectedAssetId opens with nothing chosen (zero or several agent participants upstream)", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      const select = container.querySelector(
        "#routine-panel-target",
      ) as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    test("a subject with preselectedAssetId shows that target already chosen, visibly", async () => {
      await renderPanel({
        routineId: null,
        workbenchId: "ch_1",
        preselectedAssetId: "asset_myra",
      });
      await settle();
      const select = container.querySelector(
        "#routine-panel-target",
      ) as HTMLSelectElement;
      expect(select.value).toBe("asset_myra");
    });

    test("a preselected target is replaceable: picking a different one, then naming the routine, creates with the newly picked definitionAssetId", async () => {
      await renderPanel({
        routineId: null,
        workbenchId: "ch_1",
        preselectedAssetId: "asset_myra",
      });
      await settle();

      selectTarget("asset_digest");
      await settle();

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(createRoutineCalls[0]?.["definitionAssetId"]).toBe("asset_digest");
    });

    test("empty target list shows the empty state with a link to Agents settings, not a picker", async () => {
      targets = [];
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      expect(container.querySelector("#routine-panel-target")).toBeNull();
      expect(container.textContent).toContain(
        "No deployable workflows yet — author or install one",
      );
      expect(buttonWithText("Go to Agents")).toBeDefined();
    });

    test("a failed targets fetch shows an honest inline error, not a silent empty picker", async () => {
      targetsRequestFails = true;
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      expect(container.querySelector("#routine-panel-target")).toBeNull();
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
    });

    test("no workbench in scope: falls back to the workbench's existing Myra workbench for delivery, never minting a new one", async () => {
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
      await renderPanel({ routineId: null });
      await settle();

      selectTarget("asset_myra");
      await settle();

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Nightly summary");
      await settle();

      expect(createRoutineCalls).toHaveLength(1);
      expect(createRoutineCalls[0]?.["deliveryWorkbenchId"]).toBe("ch_myra");
      expect(createRoutineCalls[0]?.["definitionAssetId"]).toBe("asset_myra");
      expect(createWorkbenchCalls).toHaveLength(0);
    });

    test("rapid Name and Instruction blur in the same tick serialize into one create, then one update — never two creates", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      selectTarget("asset_myra");
      await settle();

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
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      selectTarget("asset_myra");
      await settle();
      networkDelayMs = 30;
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

    test("existing-routine mode shows the current target already selected in the same editable picker as create mode (CL-7358)", async () => {
      createdRoutine = routineRecord({ definitionAssetId: "asset_digest" });
      routines = [createdRoutine];
      await renderPanel({ routineId: "rtn_1" });
      await settle();

      const select = container.querySelector(
        "#routine-panel-target",
      ) as HTMLSelectElement;
      expect(select).not.toBeNull();
      expect(select.value).toBe("asset_digest");
      expect(container.textContent).toContain("Morning digest workflow");
    });

    test("retargeting an existing routine sends a target-only PATCH — no other field rides along", async () => {
      createdRoutine = routineRecord({ definitionAssetId: "asset_myra" });
      routines = [createdRoutine];
      await renderPanel({ routineId: "rtn_1" });
      await settle();

      selectTarget("asset_digest");
      await settle();

      expect(updatedPatches).toContainEqual({
        definitionAssetId: "asset_digest",
      });
      expect(updatedPatches).toHaveLength(1);
    });

    test("a server rejection on retarget (409 unfrozen/undeployed) reverts the picker and shows the error, without losing other unsaved input", async () => {
      createdRoutine = routineRecord({ definitionAssetId: "asset_myra" });
      routines = [createdRoutine];
      await renderPanel({ routineId: "rtn_1" });
      await settle();

      const instruction = fieldByLabel(
        "What should this routine do each time it runs?",
      ) as HTMLTextAreaElement;
      const textareaSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set as (this: HTMLTextAreaElement, v: string) => void;
      act(() => {
        textareaSetter.call(instruction, "not yet blurred");
        instruction.dispatchEvent(new Event("input", { bubbles: true }));
      });

      patchTargetRejection = {
        status: 409,
        message: "That target isn't deployed yet.",
      };
      selectTarget("asset_digest");
      await settle();

      const select = container.querySelector(
        "#routine-panel-target",
      ) as HTMLSelectElement;
      expect(select.value).toBe("asset_myra");
      expect(container.textContent).toContain(
        "That target isn't deployed yet.",
      );
      expect(instruction.value).toBe("not yet blurred");
    });

    test("an unavailable current target disables Run now until a valid target is chosen", async () => {
      createdRoutine = routineRecord({ definitionAssetId: "asset_gone" });
      routines = [createdRoutine];
      await renderPanel({ routineId: "rtn_1" });
      await settle();

      expect(buttonWithText("Run now")?.hasAttribute("disabled")).toBe(true);

      selectTarget("asset_digest");
      await settle();

      expect(buttonWithText("Run now")?.hasAttribute("disabled")).toBe(false);
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
      granolaConnected = true;
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

    test("the trigger popover hides Granola call notes when Granola is not connected (CL-6759)", async () => {
      granolaConnected = false;
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      let items = [...document.querySelectorAll('[role="menuitem"]')].map(
        (el) => el.textContent?.trim(),
      );
      expect(items).toContain("On a schedule ›");
      expect(items).not.toContain("Granola call notes");
      expect(items.every((label) => !label?.includes("Granola"))).toBe(true);

      act(() => root.unmount());
      container.remove();
      container = document.createElement("div");
      document.body.appendChild(container);
      root = createRoot(container);
      granolaConnected = true;
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      items = [...document.querySelectorAll('[role="menuitem"]')].map((el) =>
        el.textContent?.trim(),
      );
      expect(items).toContain("Granola call notes");
    });

    test("a failed capabilities probe still offers Slack — never hides solely because the probe failed (CL-6835)", async () => {
      capabilitiesProbeFails = true;
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      const items = [...document.querySelectorAll('[role="menuitem"]')].map(
        (el) => el.textContent?.trim(),
      );
      expect(items).toContain("Slack");
    });

    test("picking a schedule preset commits the trigger in one click — no sub-menu chain", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      selectTarget("asset_myra");
      await settle();
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

    // CL-6755: a write's apply-from-server must not clobber draft fields the
    // user has typed but not yet committed (instruction still focused, or a
    // schedule picked while instruction was mid-edit).
    test("committing a schedule does not wipe an in-progress instruction that was never blurred", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      selectTarget("asset_myra");
      await settle();

      const name = fieldByLabel("Name this routine") as HTMLInputElement;
      fillAndBlur(name, "Morning digest");
      await settle();

      const instruction = fieldByLabel(
        "What should this routine do each time it runs?",
      ) as HTMLTextAreaElement;
      const textareaSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set as (this: HTMLTextAreaElement, v: string) => void;
      act(() => {
        textareaSetter.call(instruction, "Summarize overnight activity");
        instruction.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(instruction.value).toBe("Summarize overnight activity");

      act(() => openMenu(buttonWithText("+ Add trigger")));
      await settle();
      const onSchedule = [
        ...document.querySelectorAll('[role="menuitem"]'),
      ].find((el) => el.textContent?.includes("On a schedule"));
      act(() => (onSchedule as HTMLElement).click());
      await settle();
      act(() => buttonWithText("Daily 9:00")?.click());
      await settle();

      const instructionAfter = fieldByLabel(
        "What should this routine do each time it runs?",
      ) as HTMLTextAreaElement;
      expect(instructionAfter.value).toBe("Summarize overnight activity");
      expect(container.textContent).toContain("At 09:00 (UTC)");
    });

    test("typing instruction while name create is in flight survives the create ack", async () => {
      await renderPanel({ routineId: null, workbenchId: "ch_1" });
      await settle();
      selectTarget("asset_myra");
      await settle();
      networkDelayMs = 40;

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
        name.dispatchEvent(new Event("focusout", { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(container.textContent).toContain("Saving…");

      act(() => {
        textareaSetter.call(instruction, "Summarize overnight activity");
        instruction.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settle();

      const instructionAfter = fieldByLabel(
        "What should this routine do each time it runs?",
      ) as HTMLTextAreaElement;
      expect(instructionAfter.value).toBe("Summarize overnight activity");
      expect(createRoutineCalls).toHaveLength(1);
    });
  });
});
