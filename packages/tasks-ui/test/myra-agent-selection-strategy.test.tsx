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

import type { TaskAgentOption } from "./agent-selection-strategy";
import {
  createMyraAgentSelectionStrategy,
  MyraChoiceSummary,
  MYRA_AUTO_SELECTION_ID,
} from "./myra-agent-selection-strategy";

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
