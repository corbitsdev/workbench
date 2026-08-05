// Screens without live backing must say so: every list renders an honest
// empty state from real (empty) hub responses, never placeholder rows, and a
// missing session is reported as exactly that.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery, Approval, Instance } from "../src/api";
import { ApprovalsPage } from "../src/pages/approvals-page";
import { ChatPage } from "../src/pages/chat-page";
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
    const markup = renderToStaticMarkup(<RunsPage instances={emptyPage} />);
    expect(markup).toContain("No active runs");
  });

  test("library says it is empty", () => {
    const markup = renderToStaticMarkup(<LibraryPage agents={emptyPage} />);
    expect(markup).toContain("The library is empty");
  });

  test("approvals says nothing is waiting", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsPage approvals={ready<Approval[]>([])} />,
    );
    expect(markup).toContain("No approvals waiting");
  });

  test("settings renders with no workspace memberships", () => {
    const markup = renderToStaticMarkup(
      <SettingsPage profile={profile} principals={emptyPage} />,
    );
    expect(markup).toContain("ada@example.com");
    expect(markup).toContain("No workspaces yet");
  });

  test("chat says it is not connected and disables the composer", () => {
    const markup = renderToStaticMarkup(<ChatPage />);
    expect(markup).toContain("No conversation yet");
    expect(markup).toMatch(/<textarea[^>]*disabled/);
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
        agents={unauthenticated}
        instances={unauthenticated}
      />,
    );
    expect(markup).toContain("Sign in required");
  });
});

describe("live data", () => {
  test("runs renders a running instance from hub data", () => {
    const instance: Instance = {
      id: "inst_1",
      tenantId: "tenant_1",
      tenantName: "Acme",
      agentId: "agent_1",
      agentName: "Researcher",
      address: "acme/researcher",
      status: "running",
      createdAt: "2026-08-05T11:00:00.000Z",
    };
    const markup = renderToStaticMarkup(
      <RunsPage
        instances={ready({ data: [instance], nextCursor: null })}
        now={Date.parse("2026-08-05T12:00:00.000Z")}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("acme/researcher");
    expect(markup).toContain("running");
    expect(markup).toContain("ago");
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
        agents={emptyPage}
        instances={emptyPage}
      />,
    );
    expect(markup).toContain("Welcome back, Ada");
    expect(markup).toContain("Workspaces");
  });
});
