// Screen-level proof for the Routines page's pure components: real
// (possibly empty) `APIQuery` props in, honest markup out — no live fetch.
// List rows live in shell col2; this page owns create + detail only.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery } from "../src/api";
import {
  RoutineDetailPage,
  RoutinesListPage,
  connectorBadgeLabel,
} from "../src/pages/routines-page";
import type { Routine, RoutineRun } from "../src/routines-api";
import type { WebhookTrigger } from "../src/webhook-triggers-api";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const routine: Routine = {
  id: "rtn_1",
  name: "Morning brief",
  definitionId: "wfd_1",
  trigger: { kind: "daily", hour: 9, minute: 0 },
  scope: "bench",
  input: {
    draftedSteps: [{ title: "Pull signups", detail: "CSV from warehouse" }],
  },
  enabled: true,
  deliveryChannelId: "ch_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const researcherDefinition = {
  id: "wfd_1",
  name: "Researcher",
  status: "deployed",
  whatItDoes: "Pulls research from connected sources.",
  requiredConnections: [] as const,
  exampleOutput: "Research summary, three sources cited.",
  typicalDuration: "a few minutes",
};

const listProps = {
  runHistories: new Map<string, readonly RoutineRun[]>(),
  liveRuns: ready([]),
  definitions: [] as const,
  channels: [] as const,
  selectedId: null as string | null,
  onSelect: (_id: string | null) => {},
  onCreate: () => Promise.resolve(),
  onCreateWebhookBinding: () =>
    Promise.resolve({ id: "wht_1", secret: "test-secret" }),
  webhookTrigger: null,
  onRotateWebhookSecret: () => Promise.resolve({ secret: "rotated-secret" }),
  onDescribe: () =>
    Promise.resolve({
      id: "draft_test",
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
    }),
  onApproveDraft: () => Promise.resolve(),
  onDiscardDraft: () => Promise.resolve(),
  onToggleEnabled: () => {},
  onRunNow: () => Promise.resolve(),
  onEdit: () => Promise.resolve(),
  onOpenRuns: () => {},
  onOpenChannel: (_channelId: string) => {},
};

describe("RoutinesListPage", () => {
  test("says there are no routines yet when the list is empty", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage routines={ready([])} {...listProps} />,
    );
    expect(markup).toContain("No routines yet");
    expect(markup).toContain("Create one from a workflow or a prompt.");
    expect(markup).toContain("New routine");
  });

  test("prompts to select when routines exist but none is open", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        definitions={[researcherDefinition]}
      />,
    );
    expect(markup).toContain("Select a routine");
    // List rows live in col2 — the stage must not re-render the master list.
    expect(markup).not.toContain("Morning brief");
    expect(markup).not.toContain("rtn_1");
  });

  test("selected routine shows steps and recent runs", () => {
    const runHistories = new Map<string, readonly RoutineRun[]>([
      [
        routine.id,
        [
          {
            runId: "run_1",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T00:00:00.000Z",
            run: { status: "completed" },
          },
        ],
      ],
    ]);
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        runHistories={runHistories}
        selectedId={routine.id}
        definitions={[researcherDefinition]}
        channels={[
          {
            id: "ch_1",
            title: "Ops",
            kind: "channel",
            pinned: false,
            participants: [],
          },
        ]}
      />,
    );
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Daily at 09:00 UTC, delivers to Ops.");
    expect(markup).toContain("Pull signups");
    expect(markup).toContain("Recent runs");
    expect(markup).toContain("completed");
    expect(markup).not.toContain("rtn_1");
  });

  test("shows an Edit action and an insights link instead of a local toggle", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        selectedId={routine.id}
        definitions={[researcherDefinition]}
      />,
    );
    expect(markup).toContain("Edit");
    expect(markup).toContain("All runs &amp; traces →");
    expect(markup).not.toContain("Show three");
  });

  test("a recent-run row deep-links to the routine's delivery channel", () => {
    const runHistories = new Map<string, readonly RoutineRun[]>([
      [
        routine.id,
        [
          {
            runId: "run_1",
            triggeredBy: "schedule",
            createdAt: "2026-01-01T00:00:00.000Z",
            run: { status: "completed" },
          },
        ],
      ],
    ]);
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        runHistories={runHistories}
        selectedId={routine.id}
        definitions={[researcherDefinition]}
      />,
    );
    expect(markup).toContain("routine-run-row-linked");
    expect(markup).toContain('role="link"');
  });
});

describe("RoutineDetailPage", () => {
  test("shows the routine's name, cadence, and empty run history", () => {
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(routine)}
        runs={ready<readonly RoutineRun[]>([])}
        onBack={() => {}}
        onOpenRuns={() => {}}
        onOpenChannel={(_channelId: string) => {}}
        onEdit={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("Morning brief");
    expect(markup).toContain("Daily at 09:00 UTC");
    expect(markup).toContain("No runs yet");
    expect(markup).toContain("Pull signups");
  });

  test("renders run history with a resolved status", () => {
    const run: RoutineRun = {
      runId: "run_1",
      triggeredBy: "manual",
      createdAt: "2026-01-01T00:00:00.000Z",
      run: { status: "completed" },
    };
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(routine)}
        runs={ready<readonly RoutineRun[]>([run])}
        onBack={() => {}}
        onOpenRuns={() => {}}
        onOpenChannel={(_channelId: string) => {}}
        onEdit={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("manual");
    expect(markup).toContain("completed");
  });
});

const webhookRoutine: Routine = {
  ...routine,
  id: "rtn_webhook",
  name: "Support digest",
  trigger: { kind: "webhook", webhookTriggerId: "wht_1" },
};

const webhookTriggerFixture: WebhookTrigger = {
  id: "wht_1",
  tenantId: "tnt_1",
  name: "Support digest",
  workflowDefinitionId: "wfd_1",
  inputTemplate: "New webhook delivery.",
  enabled: true,
  createdBy: "usr_1",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastFiredAt: null,
};

describe("webhook trigger panel", () => {
  test("RoutinesListPage detail shows the hook URL and a masked-secret note for a webhook routine", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([webhookRoutine])}
        selectedId={webhookRoutine.id}
        webhookTrigger={ready(webhookTriggerFixture)}
        definitions={[researcherDefinition]}
      />,
    );
    expect(markup).toContain("/api/webhooks/wht_1");
    expect(markup).toContain("Rotate secret");
    expect(markup).toContain("Hidden");
  });

  test("RoutinesListPage detail omits the webhook section for a scheduled routine", () => {
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([routine])}
        selectedId={routine.id}
        definitions={[researcherDefinition]}
      />,
    );
    expect(markup).not.toContain("Rotate secret");
  });

  test("RoutineDetailPage shows the hook URL for a webhook routine", () => {
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(webhookRoutine)}
        runs={ready<readonly RoutineRun[]>([])}
        webhookTrigger={ready(webhookTriggerFixture)}
        onRotateWebhookSecret={() =>
          Promise.resolve({ secret: "rotated-secret" })
        }
        onBack={() => {}}
        onOpenRuns={() => {}}
        onOpenChannel={(_channelId: string) => {}}
        onEdit={() => Promise.resolve()}
      />,
    );
    expect(markup).toContain("/api/webhooks/wht_1");
    expect(markup).toContain("Rotate secret");
  });

  test("clicking Rotate secret reveals the newly rotated secret", async () => {
    let rotateCalls = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(RoutinesListPage, {
          ...listProps,
          routines: ready([webhookRoutine]),
          selectedId: webhookRoutine.id,
          webhookTrigger: ready(webhookTriggerFixture),
          definitions: [researcherDefinition],
          onRotateWebhookSecret: () => {
            rotateCalls += 1;
            return Promise.resolve({ secret: "freshly-rotated" });
          },
        }),
      );
    });
    try {
      const rotateButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.includes("Rotate secret"),
      );
      expect(rotateButton).not.toBeUndefined();
      await act(async () => {
        rotateButton?.click();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(rotateCalls).toBe(1);
      expect(container.textContent).toContain("freshly-rotated");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe("connectorBadgeLabel registry-drift logging", () => {
  test("logs a catalog/registry drift unconditionally, not only in dev builds", () => {
    const calls: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => calls.push(args);
    try {
      const label = connectorBadgeLabel("not-a-real-connector-id");
      expect(label).toBe("not-a-real-connector-id");
      expect(calls.length).toBe(1);
      expect(String(calls[0]?.[0])).toContain("not-a-real-connector-id");
    } finally {
      console.error = original;
    }
  });
});
