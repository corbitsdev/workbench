// CL-6462's quiet half: once Myra is up the person is already in a
// conversation, so whatever is still deploying gets one dismissible line
// and nothing more. It must also stay out of the way entirely for
// everyone who did not just connect a provider — no line, no request.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import {
  markSetupInProgress,
  SetupProgressNote,
} from "../src/shell/setup-progress-note";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  sessionStorage.clear();
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function stubStatus(body: unknown) {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return calls;
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<SetupProgressNote />);
  });
  await settle();
  await settle();
}

describe("SetupProgressNote", () => {
  test("says nothing, and asks nothing, for someone who did not just connect", async () => {
    const calls = stubStatus({ kind: "provisioning", setupAgentReady: true });

    await render();

    expect(container?.textContent).toBe("");
    expect(calls).toEqual([]);
  });

  test("shows one quiet dismissible line while the rest is still coming online", async () => {
    stubStatus({ kind: "provisioning", setupAgentReady: true });
    markSetupInProgress();

    await render();

    expect(container?.textContent).toContain("still setting up");
    const dismiss = container?.querySelector('[aria-label="Dismiss"]');
    expect(dismiss).not.toBeNull();

    await act(async () => {
      (dismiss as HTMLButtonElement).click();
    });
    expect(container?.textContent).toBe("");
  });

  test("shows nothing once the bench reports everything live, and stops watching", async () => {
    stubStatus({ kind: "ready", setupAgentReady: true });
    markSetupInProgress();

    await render();

    expect(container?.textContent).toBe("");
    expect(sessionStorage.getItem("workbench.setup-in-progress")).toBeNull();
  });
});
