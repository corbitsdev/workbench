import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { APIQuery } from "@corbits/api-query";
import { RoutinesListPage } from "../src/pages/routines-page";
import type {
  CreateRoutineInput,
  Routine,
  RoutineDraft,
  RoutineRun,
} from "../src/routines-api";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof RoutinesListPage>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(RoutinesListPage, props));
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

function buttonWithText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
}

function cardWithTitle(title: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((button) =>
    button.textContent?.trim().startsWith(title),
  );
}

const definitions = [
  {
    id: "wfd_3",
    assetName: "last-30-days-research",
    name: "Last 30 days research report",
    status: "deployed",
    whatItDoes: "Researches a topic over the last 30 days.",
    requiredConnections: [],
    exampleOutput: "Cited report: 3 new competing launches this month",
    typicalDuration: "1-2 minutes",
    triggerFields: [
      {
        key: "topic",
        label: "Topic",
        placeholder: "AI coding agents",
        required: true,
        help: "What to research over the last 30 days.",
      },
    ],
  },
] as const;

const channels = [
  {
    id: "ch_1",
    title: "Ops",
    kind: "channel" as const,
    pinned: false,
    participants: [],
  },
];

function baseProps(overrides: {
  onCreate?: (input: CreateRoutineInput) => Promise<void>;
}) {
  return {
    routines: ready([] as readonly Routine[]),
    runHistories: new Map<string, readonly RoutineRun[]>(),
    liveRuns: ready([]),
    definitions,
    channels,
    selectedId: null,
    onSelect: () => {},
    onCreate: overrides.onCreate ?? (() => Promise.resolve()),
    onCreateWebhookBinding: () =>
      Promise.resolve({ id: "wht_1", secret: "test-secret" }),
    webhookTrigger: null,
    onRotateWebhookSecret: () => Promise.resolve({ secret: "rotated-secret" }),
    onDescribe: () =>
      Promise.resolve({
        id: "draft_1",
        prompt: "test",
        status: "draft" as const,
        proposedSteps: [],
        proposedTrigger: null,
        proposedName: null,
        definitionId: null,
        deliveryChannelId: "ch_1",
        scope: "bench" as const,
        autonomy: null,
        approvedRoutineId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } satisfies RoutineDraft),
    onApproveDraft: () => Promise.resolve(),
    onDiscardDraft: () => Promise.resolve(),
    onToggleEnabled: () => {},
    onRunNow: () => Promise.resolve(),
    onEdit: () => Promise.resolve(),
    onOpenRuns: () => {},
    onOpenChannel: () => {},
  };
}

describe("keyboard-submit bypass of required triggerFields gating", () => {
  test("dispatching a native form submit (Enter key) while a required field is blank does not create the routine or advance the step", async () => {
    let created: CreateRoutineInput | null = null;
    mount(
      baseProps({
        onCreate: (input) => {
          created = input;
          return Promise.resolve();
        },
      }),
    );
    await settle();
    act(() => {
      buttonWithText("New routine")?.click();
    });
    await settle();

    act(() => {
      cardWithTitle("Last 30 days research report")?.click();
    });
    act(() => {
      buttonWithText("Next")?.click();
    });
    await settle();

    expect(document.body.textContent).toContain("Trigger inputs");
    expect(buttonWithText("Next")?.hasAttribute("disabled")).toBe(true);

    const form = document.body.querySelector("form");
    expect(form).not.toBeNull();
    act(() => {
      form?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    // Still on Configure, nothing created.
    expect(document.body.textContent).toContain("Step 2 of 3");
    expect(created).toBeNull();
  });
});
