// The routine editor/detail pane (CL-6125): create with a schedule trigger,
// an optimistic Active toggle, Test run firing the run-once call, and the
// "+ Add trigger" popover listing only honestly-working triggers (schedule
// and Granola always, Slack only when this deployment has it mounted).

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
const {
  CanvasAvailabilityProvider,
} = await import("../src/shell/canvas-availability");
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

const assistantDefinition = {
  id: "wfd_assistant",
  name: "assistant",
  status: "deployed",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let createdRoutine: Record<string, unknown> | null = null;
let updatedPatches: Record<string, unknown>[] = [];
let runNowCalls = 0;
let slackConfigured = false;

function routineRecord(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "rtn_1",
    name: "Morning digest",
    definitionId: assistantDefinition.id,
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
    return jsonResponse({ data: [assistantDefinition], nextCursor: null });
  }
  if (url.includes("/routines/") && url.endsWith("/run") && method === "POST") {
    runNowCalls += 1;
    return jsonResponse({ runId: "run_1" });
  }
  if (url.includes("/routines/") && url.endsWith("/runs")) {
    return jsonResponse({ items: [], nextCursor: null });
  }
  if (url.match(/\/routines\/rtn_1$/) && method === "PATCH") {
    const patch: Record<string, unknown> = JSON.parse(String(init?.body));
    updatedPatches.push(patch);
    createdRoutine = { ...(createdRoutine ?? routineRecord()), ...patch };
    return jsonResponse(createdRoutine);
  }
  if (url.match(/\/routines\/rtn_1$/) && method === "GET") {
    return jsonResponse(createdRoutine ?? routineRecord({ enabled: false }));
  }
  if (url.endsWith("/routines") && method === "POST") {
    const body: Record<string, unknown> = JSON.parse(String(init?.body));
    createdRoutine = routineRecord({
      name: body["name"],
      trigger: body["trigger"] ?? null,
      input: body["input"] ?? {},
    });
    return jsonResponse(createdRoutine);
  }
  return Promise.reject(new Error(`unrouted fetch in routine-panel test: ${url}`));
}

describe("RoutinePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let closed: boolean;

  beforeEach(() => {
    globalThis.fetch = routeFetch as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    closed = false;
    createdRoutine = null;
    updatedPatches = [];
    runNowCalls = 0;
    slackConfigured = false;
    toastMock.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    globalThis.fetch = realFetch;
    window.localStorage.clear();
  });

  async function renderPanel(routineId: string | null = null): Promise<void> {
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
                routine={{ routineId }}
                focus={false}
                openProfile={noop}
                openArtifact={noop}
                openRoutine={noop}
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

  // Radix's dropdown-menu trigger opens on `pointerdown`, not `click` —
  // mirroring how a real mouse interaction reaches it (see sidebar.test.tsx).
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
    if (setter === undefined) throw new Error("native value setter unavailable");
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // React's synthetic `onBlur` listens for the bubbling "focusout"
      // native event, not "blur" (which does not bubble) — dispatching
      // "blur" alone never reaches React's root-delegated handler.
      el.dispatchEvent(new Event("focusout", { bubbles: true }));
    });
  }

  test("back chevron closes the canvas", async () => {
    await renderPanel();
    const back = container.querySelector('[aria-label="Back"]');
    expect(back).not.toBeNull();
    act(() => {
      (back as HTMLButtonElement).click();
    });
    expect(closed).toBe(true);
  });

  test("creating a routine with a schedule trigger saves on Name blur, then the trigger commits with a patch", async () => {
    await renderPanel();

    const name = fieldByLabel("Name this routine") as HTMLInputElement;
    expect(name).toBeDefined();
    fillAndBlur(name, "Morning digest");
    await settle();

    expect(createdRoutine?.["name"]).toBe("Morning digest");
    expect(toastMock).toHaveBeenCalled();

    // Trigger popover → "On a schedule" → picking Daily commits a patch.
    const addTrigger = buttonWithText("+ Add trigger");
    expect(addTrigger).toBeDefined();
    act(() => {
      openMenu(addTrigger);
    });
    await settle();
    const onSchedule = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.includes("On a schedule"),
    );
    expect(onSchedule).toBeDefined();
    act(() => {
      (onSchedule as HTMLElement).click();
    });
    await settle();

    const cadenceMenu = container.querySelector("#routine-cadence");
    expect(cadenceMenu).not.toBeNull();
    act(() => {
      openMenu(cadenceMenu as HTMLElement);
    });
    await settle();
    const daily = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === "Daily",
    );
    act(() => {
      (daily as HTMLElement).click();
    });
    await settle();

    expect(updatedPatches.some((p) => (p["trigger"] as { kind: string } | undefined)?.kind === "daily")).toBe(true);
  });

  test("Active toggle is optimistic — flips immediately, before the PATCH resolves", async () => {
    createdRoutine = routineRecord({ enabled: false });
    await renderPanel("rtn_1");

    const toggle = container.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => {
      toggle.click();
    });
    // Optimistic: flips before the in-flight PATCH settles.
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await settle();
    expect(updatedPatches).toContainEqual({ enabled: true });
  });

  test("Test run is disabled until the routine is saved, then fires the run-once call", async () => {
    await renderPanel();
    const runButton = buttonWithText("Run now");
    expect(runButton?.hasAttribute("disabled")).toBe(true);

    act(() => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createdRoutine = routineRecord({ enabled: true });
    await renderPanel("rtn_1");

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
    await renderPanel();
    act(() => {
      openMenu(buttonWithText("+ Add trigger"));
    });
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
    await renderPanel();
    act(() => {
      openMenu(buttonWithText("+ Add trigger"));
    });
    await settle();
    items = [...document.querySelectorAll('[role="menuitem"]')].map(
      (el) => el.textContent?.trim(),
    );
    expect(items).toContain("Slack");
  });
});
