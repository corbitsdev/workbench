// CL-6465: Evals is a brand new surface reading `packages/evals`'s
// real eval-run store through the hub's `/eval-runs` routes (mounted in
// apps/hub/src/index.ts alongside insights and bench-settings). These
// tests exercise the real fetch wiring `EvalsRoute` owns, same shape as
// `insights-route.test.tsx`.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { EvalsRoute } from "../src/pages/evals-page";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const membership = {
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

const passedRun = {
  id: "evalrun_1",
  evalName: "factory",
  evalDescription: "The factory eval",
  configName: "default",
  startedAt: new Date(Date.now() - 120_000).toISOString(),
  finishedAt: new Date(Date.now() - 60_000).toISOString(),
  stepCount: 3,
  scorerTally: { passed: 3, failed: 0, skipped: 0 },
};

const runDetail = {
  id: "evalrun_1",
  evalName: "factory",
  evalDescription: "The factory eval",
  configName: "default",
  startedAt: passedRun.startedAt,
  finishedAt: passedRun.finishedAt,
  steps: [
    {
      stepIndex: 0,
      turn: {
        human: "Review the open PR",
        replyText: "Here is my review.",
        toolCalls: [
          {
            name: "list_prs",
            arguments: { repo: "workbench" },
            isError: false,
            result: "[]",
          },
        ],
      },
      scorerReports: [
        {
          name: "leaves-a-review",
          score: 1,
          pass: true,
          reason: "posted a review comment",
        },
      ],
    },
  ],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(runs: readonly unknown[]): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : String(input);
    if (path.includes("/api/me/principals"))
      return Promise.resolve(json(membership));
    if (path.includes("/eval-runs/runs/evalrun_1"))
      return Promise.resolve(json(runDetail));
    if (path.includes("/eval-runs/runs"))
      return Promise.resolve(json({ runs }));
    return Promise.resolve(json({}));
  }) as typeof fetch;
}

async function mount(path = "/evals") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <EvalsRoute path={path} />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}

describe("EvalsRoute", () => {
  test("a real eval run reaches the list with its outcome", async () => {
    stubFetch([passedRun]);
    const el = await mount();
    expect(el.textContent).toContain("factory");
    expect(el.textContent).toContain("Passed");
  });

  test("an empty store shows an honest empty state, not a fabricated row", async () => {
    stubFetch([]);
    const el = await mount();
    expect(el.textContent).toContain("No eval runs yet");
    expect(el.textContent).not.toContain("bun run eval");
  });

  test("a run's detail page renders its real steps, tool calls, and scorer reports", async () => {
    stubFetch([passedRun]);
    const el = await mount("/evals/evalrun_1");
    expect(el.textContent).toContain("Review the open PR");
    expect(el.textContent).toContain("Here is my review.");
    expect(el.textContent).toContain("list_prs");
    expect(el.textContent).toContain("leaves-a-review");
  });
});
