// Screens without live backing must say so: every list renders an honest
// empty state from real (empty) hub responses, never placeholder rows, and a
// missing session is reported as exactly that.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery, Approval, WorkflowRun } from "../src/api";
import { ApprovalsPage } from "../src/pages/approvals-page";
import { HomePage } from "../src/pages/home-page";
import { LibraryPage } from "../src/pages/library-page";
import { RunsPage } from "../src/pages/runs-page";
import { SettingsPage } from "../src/pages/settings-page";

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
  test("runs says it has no active runs", () => {
    const markup = renderToStaticMarkup(<RunsPage runs={emptyPage} />);
    expect(markup).toContain("No active runs");
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

  test("settings renders with no bench memberships", () => {
    const markup = renderToStaticMarkup(
      <SettingsPage profile={profile} principals={emptyPage} />,
    );
    expect(markup).toContain("ada@example.com");
    expect(markup).toContain("No benches yet");
  });
});

describe("signed-out state", () => {
  test("settings reports a missing session instead of empty panels", () => {
    const markup = renderToStaticMarkup(
      <SettingsPage profile={unauthenticated} principals={unauthenticated} />,
    );
    expect(markup).toContain("Sign in required");
    expect(markup).not.toContain("Account");
  });

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

  test("runs renders a running workflow run from hub data", () => {
    const markup = renderToStaticMarkup(
      <RunsPage
        runs={ready({ data: [run], nextCursor: null })}
        now={Date.parse("2026-08-05T12:00:00.000Z")}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("run_1@acme.localhost");
    expect(markup).toContain("running");
    expect(markup).toContain("ago");
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
