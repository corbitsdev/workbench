// AgentSkillsPicker (CL-5920): a pin can outlive its skill's visibility —
// the author made it private, renamed it, or discarded it — so a stale
// name in `selected` must still render as a removable row rather than
// vanish silently and leave the dialog unsaveable.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AgentSkillsPicker } from "../src/pages/agent-skills-picker";

const TENANT = "tnt_1";

const TRIAGE = {
  assetId: "ast_1",
  name: "triage",
  description: "Sorts inbound issues.",
  scope: "tenant",
  creatorPrincipalId: "prn_1",
  updatedAtIso: "2026-08-05T11:00:00.000Z",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const originalFetch = globalThis.fetch;

function stubSkills(skills: readonly unknown[]): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ skills }), {
      status: 200,
    })) as unknown as typeof fetch;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(props: {
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  if (container === null) throw new Error("container missing");
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AgentSkillsPicker
        tenantId={TENANT}
        idPrefix="test"
        selected={props.selected}
        onChange={props.onChange}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("AgentSkillsPicker", () => {
  test("a pin to a skill still visible renders as a normal checked checkbox", async () => {
    stubSkills([TRIAGE]);
    const el = await mount({ selected: ["triage"], onChange: () => {} });
    const checkbox = el.querySelector<HTMLInputElement>("input[type=checkbox]");
    expect(checkbox?.checked).toBe(true);
    expect(el.textContent).not.toContain("No longer available");
  });

  test("a pin to a skill the caller can no longer see renders as a removable stale row", async () => {
    stubSkills([TRIAGE]);
    const el = await mount({
      selected: ["triage", "gone-private"],
      onChange: () => {},
    });
    expect(el.textContent).toContain("gone-private");
    expect(el.textContent).toContain("No longer available");
    const remove = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove",
    );
    expect(remove).toBeDefined();
  });

  test("removing a stale pin and saving reaches a clean, saveable state", async () => {
    stubSkills([]);
    let next: readonly string[] = [];
    const el = await mount({
      selected: ["gone-private"],
      onChange: (updated) => {
        next = updated;
      },
    });
    expect(el.textContent).toContain("gone-private");
    const remove = Array.from(el.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove",
    );
    await act(async () => {
      remove?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(next).toEqual([]);
  });

  test("with no skills and no stale pins, the empty state explains there is nothing to attach", async () => {
    stubSkills([]);
    const el = await mount({ selected: [], onChange: () => {} });
    expect(el.textContent).toContain("No skills yet");
  });
});
