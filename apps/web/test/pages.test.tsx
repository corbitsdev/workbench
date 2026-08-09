// Screens without live backing must say so: every list renders an honest
// empty state from real (empty) hub responses, never placeholder rows, and a
// missing session is reported as exactly that.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArtifactSummary } from "@corbits/artifact-ui";

import type { APIQuery, Approval, WorkflowRun } from "../src/api";
import type {
  AgentDefinition,
  AgentDirectoryData,
  AgentInstance,
} from "../src/agents-api";
import { AgentsPage } from "../src/pages/agents-page";
import { ApprovalsPage } from "../src/pages/approvals-page";
import { HomePage } from "../src/pages/home-page";
import { LibraryPage } from "../src/pages/library-page";
import { SkillsPage } from "../src/pages/skills-page";
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

  test("library teaches what will appear once the seam is real", () => {
    const markup = renderToStaticMarkup(<LibraryPage artifacts={[]} />);
    expect(markup).toContain("No artifacts yet");
    expect(markup).toContain("hub doesn");
    expect(markup).toContain("expose an artifact store");
  });

  test("skills describes itself instead of faking content", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).toContain("Skills aren");
    expect(markup).toContain("built yet");
  });

  test("agents reports a missing session instead of empty panels", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={unauthenticated}
        onAgentCreated={() => undefined}
      />,
    );
    expect(markup).toContain("Sign in required");
  });

  test("approvals says nothing is waiting", () => {
    const markup = renderToStaticMarkup(
      <ApprovalsPage
        approvals={ready<Approval[]>([])}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
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

  const reportArtifact: ArtifactSummary = {
    id: "art_1",
    title: "Q3 report",
    kind: "deck",
    ownerName: "Ada",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  const csvArtifact: ArtifactSummary = {
    id: "art_2",
    title: "Signups export",
    kind: "csv",
    ownerName: null,
    createdAt: "2026-08-02T00:00:00.000Z",
  };

  test("library renders every artifact it's given", () => {
    const markup = renderToStaticMarkup(
      <LibraryPage artifacts={[reportArtifact, csvArtifact]} />,
    );
    expect(markup).toContain("Q3 report");
    expect(markup).toContain("Signups export");
  });

  const definition: AgentDefinition = {
    id: "wfd_1",
    tenantId: "tenant_1",
    name: "Researcher",
    description: "Answers research questions",
    currentVersion: "1",
    status: "deployed",
    createdAt: "2026-08-05T11:00:00.000Z",
    updatedAt: "2026-08-05T11:00:00.000Z",
  };
  const instance: AgentInstance = {
    id: "ins_1",
    definitionId: "wfd_1",
    definitionName: "Researcher",
    tenantId: "tenant_1",
    address: "ins_1@acme.localhost",
    status: "running",
    createdAt: "2026-08-05T11:00:00.000Z",
    updatedAt: "2026-08-05T11:00:00.000Z",
  };
  const directoryData: AgentDirectoryData = {
    tenantId: "tenant_1",
    definitions: [definition],
    instances: [instance],
    models: [],
  };

  test("agents lists definitions by name and description, never a raw id", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("Answers research questions");
    expect(markup).not.toContain("wfd_1");
  });

  test("agents never renders an instance's mailbox address as visible text", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialTab="instances"
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).not.toContain("ins_1@acme.localhost");
  });

  test("agents flags an instance whose definition is not in the listing", () => {
    const orphan: AgentInstance = {
      ...instance,
      id: "ins_2",
      definitionId: "wfd_missing",
    };
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready({ ...directoryData, instances: [instance, orphan] })}
        onAgentCreated={() => undefined}
        initialTab="instances"
      />,
    );
    expect(markup).toContain("Unlinked definition");
  });

  test("agents says there are no agents yet", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready({
          tenantId: "tenant_1",
          definitions: [],
          instances: [],
          models: [],
        })}
        onAgentCreated={() => undefined}
      />,
    );
    expect(markup).toContain("No agents yet");
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
