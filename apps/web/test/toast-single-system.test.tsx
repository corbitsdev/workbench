// CL-6372: a failed workbench create used to fire two toasts — the house
// `<Toaster />` from `@corbits/react-ui` (mounted in main.tsx) and a second,
// unstyled `<Toaster />` imported straight from `sonner` (mounted in
// app.tsx). Sonner's `toast()` renders into every mounted `<Toaster />`, so
// one `toast()` call rendered twice: the tokened grey box bottom-center from
// react-ui, and a default white pill bottom-right from the raw sonner
// mount. app.tsx no longer imports `sonner` at all — this file pins that a
// single `<Toaster />` mount produces exactly one toast per call, carries
// the house styling, and clears itself.

import { toast, Toaster } from "@corbits/react-ui";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { NewWorkbenchPickerRoute } from "../src/pages/new-workbench-picker";
import { clearToasts } from "./react-ui-toast-mock";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MEMBERSHIP = {
  data: [
    {
      principalId: "prn_1",
      tenantId: "tnt_1",
      tenantName: "Corbits Bench",
      tenantSlug: "corbits-bench",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

function stubFailingCreate(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals")) {
      return Promise.resolve(json(MEMBERSHIP));
    }
    if (path.includes("/workflows/definitions")) {
      return Promise.resolve(json({ data: [], nextCursor: null }));
    }
    return Promise.resolve(json({ error: "boom" }, 500));
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
  document
    .querySelectorAll("[data-sonner-toaster]")
    .forEach((node) => node.remove());
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function visibleToasts(): NodeListOf<Element> {
  return document.body.querySelectorAll("[data-sonner-toast]");
}

// Sonner keeps its toast store globally, independent of any one `<Toaster
// />` mount — an un-dismissed toast from one test reappears the moment the
// next test's fresh Toaster subscribes. Every test that leaves a toast
// showing waits out the full display duration before finishing.
async function waitForClear(): Promise<void> {
  await act(async () => {
    await sleep(2400);
  });
}

async function renderPickerWithToaster(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <NewWorkbenchPickerRoute />
          </BenchProvider>
        </NavigationProvider>
        <Toaster />
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await settle();
    if (container.querySelector('[role="radiogroup"]') !== null) break;
  }
}

describe("the one toast system (CL-6372)", () => {
  // The store outlives this file too: a sibling suite that raised a toast
  // before bun loaded this one leaves it queued, and it would render into
  // the first `<Toaster />` mounted here. Start every test from an empty
  // surface so the count below is this test's own toasts and nothing else.
  beforeEach(() => {
    clearToasts();
  });

  test("a failed workbench create fires exactly one toast", async () => {
    stubFailingCreate();
    await renderPickerWithToaster();

    const createButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Create workbench");
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 30; i++) {
      await settle();
      if (visibleToasts().length > 0) break;
    }

    const shown = visibleToasts();
    expect(shown.length).toBe(1);
    expect(shown[0]?.textContent).toBe(
      "Couldn't create the workbench — try again.",
    );
    await waitForClear();
  });

  test("the failure toast carries the house styling, not sonner's default", async () => {
    stubFailingCreate();
    await renderPickerWithToaster();

    const createButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Create workbench");
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 30; i++) {
      await settle();
      if (visibleToasts().length > 0) break;
    }

    const shown = visibleToasts()[0];
    expect(shown?.classList.contains("corbits-toast")).toBe(true);
    expect(shown?.getAttribute("data-styled")).toBe("false");
    const region = document.body.querySelector("[data-sonner-toaster]");
    expect(region?.getAttribute("data-y-position")).toBe("bottom");
    expect(region?.getAttribute("data-x-position")).toBe("center");
    await waitForClear();
  });

  test("a second toast dismisses the first instead of stacking", async () => {
    stubFailingCreate();
    await renderPickerWithToaster();

    act(() => toast("First"));
    await settle();
    act(() => toast("Second"));
    await settle();

    const staying = document.body.querySelectorAll(
      '[data-sonner-toast][data-removed="false"]',
    );
    expect(staying.length).toBe(1);
    expect(staying[0]?.textContent).toBe("Second");
    await waitForClear();
  });

  test("the toast dismisses itself after its display duration", async () => {
    stubFailingCreate();
    await renderPickerWithToaster();

    act(() => toast("Grant revoked"));
    await settle();
    expect(visibleToasts().length).toBe(1);

    await act(async () => {
      await sleep(2400);
    });
    expect(visibleToasts().length).toBe(0);
  });
});
