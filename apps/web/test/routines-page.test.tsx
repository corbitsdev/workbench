// Screen-level proof for the Routines page's pure components: real
// (possibly empty) `APIQuery` props in, honest markup out — no live fetch.
// List rows live in shell col2; this page owns create + detail only.

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery } from "@corbits/api-query";
import { RoutineDetailPage, RoutinesListPage } from "../src/pages/routines-page";
import type { Routine, RoutineRun } from "../src/routines-api";
import {
  CanvasAvailabilityProvider,
  type RoutinePanelSubject,
} from "../src/shell/canvas-availability";
import type { WebhookTrigger } from "../src/webhook-triggers-api";

const noop = () => undefined;

/** Stands in for `ShellChromeProvider`'s position above these pages — just
 * enough of the canvas host context for `useOpenRoutineInCanvas` to resolve
 * to a real, capturing callback instead of the no-op default. */
function CanvasCapture({
  onOpenRoutine,
  children,
}: {
  readonly onOpenRoutine: (subject: RoutinePanelSubject) => void;
  readonly children: import("react").ReactNode;
}) {
  return (
    <CanvasAvailabilityProvider
      allowed={false}
      open={false}
      profile={null}
      artifact={null}
      routine={null}
      focus={false}
      openProfile={noop}
      openArtifact={noop}
      openRoutine={onOpenRoutine}
      toggleFocus={noop}
      close={noop}
    >
      {children}
    </CanvasAvailabilityProvider>
  );
}

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
  consecutiveFailures: 0,
  deadLetteredAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const researcherDefinition = {
  id: "wfd_1",
  assetName: "researcher",
  deliveryMode: "channel" as const,
  name: "Researcher",
  status: "deployed",
  whatItDoes: "Pulls research from connected sources.",
  requiredConnections: [] as const,
  exampleOutput: "Research summary, three sources cited.",
  typicalDuration: "a few minutes",
  triggerFields: [] as const,
};

const listProps = {
  runHistories: new Map<string, readonly RoutineRun[]>(),
  liveRuns: ready([]),
  definitions: [] as const,
  channels: [] as const,
  selectedId: null as string | null,
  onSelect: (_id: string | null) => {},
  webhookTrigger: null,
  onRotateWebhookSecret: () => Promise.resolve({ secret: "rotated-secret" }),
  onToggleEnabled: () => {},
  onRunNow: () => Promise.resolve(),
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

  test("a dead-lettered selected routine shows a plain-language paused banner with the real error", () => {
    const deadLettered: Routine = {
      ...routine,
      consecutiveFailures: 5,
      deadLetteredAt: "2026-01-02T00:00:00.000Z",
    };
    const runHistories = new Map<string, readonly RoutineRun[]>([
      [
        routine.id,
        [
          {
            runId: "run_fail_1",
            triggeredBy: "schedule-failed",
            createdAt: "2026-01-02T00:00:00.000Z",
            error: "sidecar unreachable",
          },
        ],
      ],
    ]);
    const markup = renderToStaticMarkup(
      <RoutinesListPage
        {...listProps}
        routines={ready([deadLettered])}
        runHistories={runHistories}
        selectedId={deadLettered.id}
        definitions={[researcherDefinition]}
      />,
    );
    expect(markup).toContain("Paused after 5 failed attempts");
    expect(markup).toContain("sidecar unreachable");
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
      />,
    );
    expect(markup).toContain("manual");
    expect(markup).toContain("completed");
  });

  test("a dead-lettered routine shows a plain-language paused state and the real error text", () => {
    const deadLettered: Routine = {
      ...routine,
      consecutiveFailures: 5,
      deadLetteredAt: "2026-01-02T00:00:00.000Z",
    };
    const failedRun: RoutineRun = {
      runId: "run_fail_1",
      triggeredBy: "schedule-failed",
      createdAt: "2026-01-02T00:00:00.000Z",
      error: 'no definition "wfd_deleted" for this tenant',
    };
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(deadLettered)}
        runs={ready<readonly RoutineRun[]>([failedRun])}
        onBack={() => {}}
        onOpenRuns={() => {}}
        onOpenChannel={(_channelId: string) => {}}
      />,
    );
    expect(markup).toContain("Paused after 5 failed attempts");
    expect(markup).toContain(
      "no definition &quot;wfd_deleted&quot; for this tenant",
    );
    expect(markup).toContain("Failed to start");
  });

  test("a healthy routine shows no paused banner", () => {
    const markup = renderToStaticMarkup(
      <RoutineDetailPage
        routine={ready(routine)}
        runs={ready<readonly RoutineRun[]>([])}
        onBack={() => {}}
        onOpenRuns={() => {}}
        onOpenChannel={(_channelId: string) => {}}
      />,
    );
    expect(markup).not.toContain("Paused after");
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

  test("Edit opens the routine panel scoped to this routine, not a dialog (CL-6125)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const opened: RoutinePanelSubject[] = [];
    act(() => {
      root.render(
        <CanvasCapture onOpenRoutine={(subject) => opened.push(subject)}>
          {createElement(RoutinesListPage, {
            ...listProps,
            routines: ready([routine]),
            selectedId: routine.id,
            definitions: [researcherDefinition],
          })}
        </CanvasCapture>,
      );
    });
    try {
      const editButton = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Edit",
      );
      expect(editButton).not.toBeUndefined();
      act(() => {
        editButton?.click();
      });
      expect(opened).toEqual([{ routineId: routine.id }]);
      expect(document.body.querySelector('[data-slot="dialog-content"]')).toBe(
        null,
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("the routine detail's 'Delivers to' line links to its space", () => {
    let openedChannelId: string | null = null;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => {
      root.render(
        createElement(RoutineDetailPage, {
          routine: ready(routine),
          runs: ready<readonly RoutineRun[]>([]),
          channels: [
            {
              id: "ch_1",
              title: "Ops",
              kind: "channel" as const,
              pinned: false,
              participants: [],
            },
          ],
          onBack: () => {},
          onOpenRuns: () => {},
          onOpenChannel: (channelId: string) => {
            openedChannelId = channelId;
          },
        }),
      );
    });
    try {
      expect(container.textContent).toContain("Delivers to");
      const link = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Ops",
      );
      expect(link).not.toBeUndefined();
      act(() => {
        link?.click();
      });
      expect(openedChannelId as string | null).toBe("ch_1");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
