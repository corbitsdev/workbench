import "../../test-setup";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  ActiveContextProvider,
  useActiveContext,
} from "../../lib/active-context-store";
import type { ActiveContext } from "@workbench/shared";

type Actor = {
  id: string;
  kind: "user" | "agent";
  displayName: string;
  email?: string;
  status: string;
};
type TimelineEntry = {
  kind: string;
  id: string;
  sourceTable: string;
  timestamp: string;
  summary: string | null;
};

let actorResult: Actor | null = null;
// When set, getActor returns a promise that never settles, keeping the query in
// `isLoading` so we can exercise the "don't publish a placeholder" path.
let actorPending = false;
let activityEntries: TimelineEntry[] = [];

mock.module("../../lib/active-workbench-context", () => ({
  useActiveWorkbench: () => ({
    activeTenantId: "tenant-1",
    loading: false,
    activeWorkbench: { id: "p1", tenantId: "tenant-1", tenantName: "Acme" },
    workbenches: [],
    setActiveWorkbench: () => {},
  }),
}));

mock.module("@workbench/client", () => ({
  getActor: () =>
    actorPending
      ? new Promise<Actor | null>(() => {})
      : Promise.resolve(actorResult),
  getPrincipalActivity: () =>
    Promise.resolve({ entries: activityEntries, nextCursor: null }),
  getPrincipalRoster: () => Promise.resolve({ instances: [], runs: [] }),
}));

import { ActorDetailPage } from "./ActorDetailPage";

function ActiveContextProbe({
  onContext,
}: {
  onContext: (c: ActiveContext | null) => void;
}) {
  onContext(useActiveContext());
  return null;
}

function renderWithProbe(principalId: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const captured: ActiveContext[] = [];
  const result = render(
    <QueryClientProvider client={client}>
      <ActiveContextProvider>
        <MemoryRouter initialEntries={[`/insights/users/${principalId}`]}>
          <Routes>
            <Route path="/insights/users/:id" element={<ActorDetailPage />} />
          </Routes>
        </MemoryRouter>
        <ActiveContextProbe onContext={(c) => c && captured.push(c)} />
      </ActiveContextProvider>
    </QueryClientProvider>,
  );
  return { result, captured };
}

describe("ActorDetailPage active-context (CL-2726)", () => {
  beforeEach(() => {
    actorResult = null;
    actorPending = false;
    activityEntries = [];
  });

  it("publishes a principal active context once the actor resolves", async () => {
    actorResult = {
      id: "pri_42",
      kind: "agent",
      displayName: "Myra",
      status: "active",
    };
    activityEntries = [
      {
        kind: "tool_call",
        id: "e1",
        sourceTable: "t",
        timestamp: "2026-01-01T00:00:00Z",
        summary: null,
      },
      {
        kind: "artifact",
        id: "e2",
        sourceTable: "t",
        timestamp: "2026-01-02T00:00:00Z",
        summary: null,
      },
    ];

    const { captured } = renderWithProbe("pri_42");

    await waitFor(() => {
      expect(captured.length).toBeGreaterThan(0);
    });

    const published = captured[captured.length - 1]!;
    expect(published.kind).toBe("principal");
    expect(published.id).toBe("pri_42");
    expect(published.label).toBe("Myra");
    if (published.kind === "principal") {
      expect(published.actorKind).toBe("agent");
      expect(published.status).toBe("active");
      expect(published.summary).toContain("2 recorded moments");
      expect(published.summary).toContain("tool calls: 1");
      expect(published.summary).toContain("artifacts: 1");
    }
  });

  it("counts unknown activity kinds in an 'other' bucket so the total never overstates", async () => {
    actorResult = {
      id: "pri_7",
      kind: "user",
      displayName: "Ada",
      status: "active",
    };
    // credential + message are not in the named summary buckets.
    activityEntries = [
      {
        kind: "credential",
        id: "e1",
        sourceTable: "t",
        timestamp: "2026-01-01T00:00:00Z",
        summary: null,
      },
      {
        kind: "message",
        id: "e2",
        sourceTable: "t",
        timestamp: "2026-01-02T00:00:00Z",
        summary: null,
      },
    ];

    const { captured } = renderWithProbe("pri_7");

    await waitFor(() => expect(captured.length).toBeGreaterThan(0));

    const published = captured[captured.length - 1]!;
    expect(published.kind).toBe("principal");
    if (published.kind === "principal") {
      expect(published.summary).toContain("2 recorded moments");
      expect(published.summary).toContain("other: 2");
      // Named buckets honestly report zero rather than absorbing the unknowns.
      expect(published.summary).toContain("tool calls: 0");
      expect(published.summary).toContain("artifacts: 0");
    }
  });

  it("does not publish a placeholder while the actor is still loading", async () => {
    // A never-settling promise keeps actorQuery.isLoading true, so a regression
    // that publishes a "Loading…" principal would surface here.
    actorPending = true;
    const { captured } = renderWithProbe("pri_missing");

    // Yield so any pending effects/microtasks flush; nothing should publish.
    await waitFor(() => expect(true).toBe(true));
    expect(captured.length).toBe(0);
  });
});
