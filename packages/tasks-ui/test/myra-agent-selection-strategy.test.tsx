// DOM-mounted render tests for `createMyraAgentSelectionStrategy` and
// `MyraChoiceSummary` — same harness `task-composer-dialog.test.tsx`
// uses (see test/dom-setup.ts for the happy-dom registration Radix
// needs). Covers: "Let Myra choose" is the default and fires
// `onSelect(MYRA_AUTO_SELECTION_ID)` on mount, one click on "Choose an
// agent yourself" reveals the manual list and picking from it forwards
// the real agent id, and `onOptionsResolved` unions the sentinel with
// the manual ids so a fresh default is never mistaken for a stale
// remembered agent by `TaskComposerDialog`'s reconciliation.
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { TaskAgentOption } from "../src/agent-selection-strategy";
import {
  createMyraAgentSelectionStrategy,
  MyraChoiceSummary,
  MYRA_AUTO_SELECTION_ID,
} from "../src/myra-agent-selection-strategy";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(element);
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

const manualAgents: readonly TaskAgentOption[] = [
  { id: "wfd_1", name: "incident-bot", description: "Incident bot" },
  { id: "wfd_2", name: "digest-bot" },
];

describe("createMyraAgentSelectionStrategy", () => {
  test("defaults to Let Myra choose on mount and reports the sentinel", async () => {
    const state: { selected: string | null } = { selected: null };
    const Strategy = createMyraAgentSelectionStrategy(async () => manualAgents);

    mount(
      createElement(Strategy, {
        tenantId: "tnt_1",
        selectedId: null,
        onSelect: (id: string) => {
          state.selected = id;
        },
        onOptionsResolved: () => undefined,
      }),
    );
    await settle();

    expect(state.selected).toBe(MYRA_AUTO_SELECTION_ID);
    const options = document.body.querySelectorAll(
      '[data-testid="new-task-agent-option"]',
    );
    expect(options).toHaveLength(2);
    const myraRadio = document.body.querySelector<HTMLInputElement>(
      'input[name="task-agent-mode"]',
    );
    expect(myraRadio?.checked).toBe(true);

    // The two options render stacked, each with its own title and
    // description as separate text — not one inline run-on sentence
    // (CL-6066: this used to render as bare `<label>` prose). No
    // role="radiogroup" here — this strategy is always hosted inside
    // task-composer-dialog.tsx's fieldset/legend "Agent", which already
    // provides the group semantics; a nested ARIA group would be
    // redundant.
    expect(document.body.querySelector('[role="radiogroup"]')).toBeNull();
    const modeRadiosNow = document.body.querySelectorAll(
      'input[name="task-agent-mode"]',
    );
    expect(modeRadiosNow).toHaveLength(2);
    const titles = [
      ...document.body.querySelectorAll(".tasks-radio-option-title"),
    ].map((el) => el.textContent);
    expect(titles).toEqual(["Let Myra choose", "Choose an agent yourself"]);
    const descriptions = [
      ...document.body.querySelectorAll(".tasks-radio-option-desc"),
    ].map((el) => el.textContent);
    expect(descriptions).toEqual([
      "Myra reads your prompt and picks or creates the right agent.",
      "Pick from your agents and set the prompt yourself.",
    ]);
  });

  test("one click on Choose an agent yourself reveals the manual list, picking forwards the real id", async () => {
    const state: { selected: string | null } = { selected: null };
    const Strategy = createMyraAgentSelectionStrategy(async () => manualAgents);

    mount(
      createElement(Strategy, {
        tenantId: "tnt_1",
        selectedId: null,
        onSelect: (id: string) => {
          state.selected = id;
        },
        onOptionsResolved: () => undefined,
      }),
    );
    await settle();

    expect(document.body.querySelector('input[name="task-agent"]')).toBeNull();

    const modeRadios = [
      ...document.body.querySelectorAll<HTMLInputElement>(
        'input[name="task-agent-mode"]',
      ),
    ];
    const chooseYourself = modeRadios[1];
    expect(chooseYourself).not.toBeUndefined();
    act(() => {
      chooseYourself?.click();
    });
    await settle();

    const manualRadios = [
      ...document.body.querySelectorAll<HTMLInputElement>(
        'input[name="task-agent"]',
      ),
    ];
    expect(manualRadios).toHaveLength(2);

    act(() => {
      manualRadios[0]?.click();
    });
    await settle();

    expect(state.selected).toBe("wfd_1");
  });

  test("onOptionsResolved unions the sentinel with the manual ids", async () => {
    let resolved: readonly string[] = [];
    const Strategy = createMyraAgentSelectionStrategy(async () => manualAgents);

    mount(
      createElement(Strategy, {
        tenantId: "tnt_1",
        selectedId: null,
        onSelect: () => undefined,
        onOptionsResolved: (ids: readonly string[]) => {
          resolved = ids;
        },
      }),
    );
    await settle();

    expect(resolved).toContain(MYRA_AUTO_SELECTION_ID);
    expect(resolved).toContain("wfd_1");
    expect(resolved).toContain("wfd_2");
  });
});

describe("MyraChoiceSummary", () => {
  test("renders the agent name and fires onViewPlannerRun with the given id", async () => {
    const state: { viewed: string | null } = { viewed: null };
    mount(
      createElement(MyraChoiceSummary, {
        agentName: "incident-bot",
        tools: ["search", "shell"],
        model: "anthropic/claude-sonnet",
        plannerRunId: "run_123",
        onViewPlannerRun: (plannerRunId: string) => {
          state.viewed = plannerRunId;
        },
      }),
    );
    await settle();

    expect(document.body.textContent).toContain("incident-bot");

    const button = [...document.body.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Why this agent?",
    );
    expect(button).not.toBeUndefined();
    act(() => {
      button?.click();
    });
    await settle();

    expect(state.viewed).toBe("run_123");
  });
});
