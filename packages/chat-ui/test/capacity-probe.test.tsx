// CL-6828: the workbench settings Capacity nav gate must not fold a failed
// provisioner probe into "unavailable". A transient miss used to hide the
// section permanently via `.catch(() => false)`.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { WorkbenchSettingsSurface } from "../src/workbench-settings";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof WorkbenchSettingsSurface>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(WorkbenchSettingsSurface, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

function baseProps(
  overrides: Partial<Parameters<typeof WorkbenchSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    workbenchId: "ch_1",
    workbenchTitle: "General",
    onBack: () => undefined,
    onInviteParticipant: () => undefined,
    ...overrides,
  };
}

const settingsFixture = {
  id: "ch_1",
  title: "General",
  kind: "workbench",
  pinned: false,
  participants: [],
  settings: {},
  contextWindow: { value: 20, source: "inherit" },
};

function stubSettingsLoad(options: {
  capacity?: Response | (() => Promise<Response>);
}) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (/\/chat\/workbenches\/[^/]+\/settings$/.test(path)) {
      return json(settingsFixture);
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    if (/\/sidecar-placement$/.test(path)) {
      if (typeof options.capacity === "function") {
        return options.capacity();
      }
      if (options.capacity !== undefined) {
        return options.capacity;
      }
      return json({ enabled: false, provisionerAvailable: true });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }) as unknown as typeof fetch;
}

function navLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".workbench-settings-nav-item")].map(
    (item) => item.textContent ?? "",
  );
}

describe("WorkbenchSettingsSurface capacity probe", () => {
  test("shows Capacity when the provisioner is available", async () => {
    stubSettingsLoad({
      capacity: json({ enabled: false, provisionerAvailable: true }),
    });
    const el = mount(baseProps());
    await settle();
    expect(navLabels(el)).toContain("Capacity");
  });

  test("hides Capacity when the provisioner is confirmed unavailable", async () => {
    stubSettingsLoad({
      capacity: json({ enabled: false, provisionerAvailable: false }),
    });
    const el = mount(baseProps());
    await settle();
    expect(navLabels(el)).not.toContain("Capacity");
  });

  test("keeps Capacity visible when the probe fails — does not fold to unavailable", async () => {
    stubSettingsLoad({
      capacity: json({}, 500),
    });
    const el = mount(baseProps());
    await settle();
    expect(el.querySelector(".workbench-settings-shell")).not.toBeNull();
    expect(navLabels(el)).toContain("Capacity");
  });

  test("keeps Capacity visible when the probe cannot connect", async () => {
    stubSettingsLoad({
      capacity: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const el = mount(baseProps());
    await settle();
    expect(el.querySelector(".workbench-settings-shell")).not.toBeNull();
    expect(navLabels(el)).toContain("Capacity");
  });
});
