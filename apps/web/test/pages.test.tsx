// Screens without live backing must say so: every list renders an honest
// empty state from real (empty) hub responses, never placeholder rows, and a
// missing session is reported as exactly that.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery, Approval, WorkflowRun } from "../src/api";
import { ApprovalsPage } from "../src/pages/approvals-page";
import { HomePage } from "../src/pages/home-page";
import { LibraryPage } from "../src/pages/library-page";
import { WorkflowsPage } from "../src/pages/workflows-page";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const emptyPage = ready({ data: [], nextCursor: null });
const unauthenticated = { kind: "unauthenticated" } as const;
const profile = ready({
  id: "user_1",
  name: "Ada",
  email: "ada@example.com",
  emailVerified: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  image: null,
});

describe("empty states", () => {
  test("workflows says it has no active workflows", () => {
    const markup = renderToStaticMarkup(<WorkflowsPage runs={emptyPage} />);
    expect(markup).toContain("No active workflows");
  });

  test("library says it is empty", () => {
    const markup = renderToStaticMarkup(<LibraryPage runs={emptyPage} />);
    expect(markup).toContain("The library is empty");
  });

  test("approvals says nothing is waiting", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsPage approvals={ready<Approval[]>([])} />,
    );
    expect(markup).toContain("No approvals waiting");
  });
});

describe("signed-out state", () => {
  test("home reports a missing session", () => {
    const markup = renderToStaticMarkup(
      <HomePage
        profile={unauthenticated}
        principals={unauthenticated}
        runs={unauthenticated}
      />,
    );
    expect(markup).toContain("Sign in required");
  });
});

describe("live data", () => {
  const run: WorkflowRun = {
    id: "run_1",
    tenantId: "tenant_1",
    tenantName: "Acme",
    definitionId: "wfd_1",
    definitionName: "Researcher",
    address: "run_1@acme.localhost",
    status: "running",
    createdAt: "2026-08-05T11:00:00.000Z",
  };

  test("workflows renders a running workflow from hub data", () => {
    const markup = renderToStaticMarkup(
      <WorkflowsPage
        runs={ready({ data: [run], nextCursor: null })}
        now={Date.parse("2026-08-05T12:00:00.000Z")}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("run_1@acme.localhost");
    expect(markup).toContain("running");
    expect(markup).toContain("ago");
  });

  test("workflows filters the chat anchor machinery's channel-host runs out", () => {
    const channelHostRun: WorkflowRun = {
      ...run,
      id: "run_2",
      definitionId: "wfd_2",
      definitionName: "ins-cd03d8e3",
      address: "run_2@acme.localhost",
    };
    const markup = renderToStaticMarkup(
      <WorkflowsPage
        runs={ready({ data: [run, channelHostRun], nextCursor: null })}
        now={Date.parse("2026-08-05T12:00:00.000Z")}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).not.toContain("ins-cd03d8e3");
  });

  test("workflows shows the empty state when only channel-host runs exist", () => {
    const channelHostRun: WorkflowRun = {
      ...run,
      definitionName: "ins-cd03d8e3",
    };
    const markup = renderToStaticMarkup(
      <WorkflowsPage
        runs={ready({ data: [channelHostRun], nextCursor: null })}
      />,
    );
    expect(markup).toContain("No active workflows");
  });

  test("library shows each definition once across its runs", () => {
    const secondRunSameDefinition: WorkflowRun = {
      ...run,
      id: "run_2",
      address: "run_2@acme.localhost",
    };
    const markup = renderToStaticMarkup(
      <LibraryPage
        runs={ready({
          data: [run, secondRunSameDefinition],
          nextCursor: null,
        })}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("Acme");
    expect(markup.match(/Researcher/g)?.length).toBe(1);
  });

  test("library never shows a channel-host definition card", () => {
    const channelHostRun: WorkflowRun = {
      ...run,
      id: "run_2",
      definitionId: "wfd_2",
      definitionName: "ins-cd03d8e3",
      address: "run_2@acme.localhost",
    };
    const markup = renderToStaticMarkup(
      <LibraryPage
        runs={ready({ data: [run, channelHostRun], nextCursor: null })}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).not.toContain("ins-cd03d8e3");
  });

  test("library shows a card per distinct definition", () => {
    const runOfOtherDefinition: WorkflowRun = {
      ...run,
      id: "run_2",
      definitionId: "wfd_2",
      definitionName: "Summarizer",
      address: "run_2@acme.localhost",
    };
    const markup = renderToStaticMarkup(
      <LibraryPage
        runs={ready({
          data: [run, runOfOtherDefinition],
          nextCursor: null,
        })}
      />,
    );
    expect(markup.match(/Researcher/g)?.length).toBe(1);
    expect(markup.match(/Summarizer/g)?.length).toBe(1);
  });

  test("home counts what the hub reports", () => {
    const markup = renderToStaticMarkup(
      <HomePage
        profile={profile}
        principals={ready({
          data: [
            {
              principalId: "prin_1",
              tenantId: "tenant_1",
              tenantName: "Acme",
              tenantSlug: "acme",
              kind: "user",
              status: "active",
              roles: [{ id: "role_1", name: "owner" }],
            },
          ],
          nextCursor: null,
        })}
        runs={emptyPage}
      />,
    );
    expect(markup).toContain("Welcome back, Ada");
    expect(markup).toContain("Benches");
  });
});
