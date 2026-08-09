// Screens without live backing must say so: every list renders an honest
// empty state from real (empty) hub responses, never placeholder rows, and a
// missing session is reported as exactly that.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ArtifactSummary } from "@corbits/artifact-ui";

import type { APIQuery } from "../src/api";
import type {
  AgentDefinition,
  AgentDirectoryData,
  AgentInstance,
} from "../src/agents-api";
import { AgentsPage } from "../src/pages/agents-page";
import { LibraryPage } from "../src/pages/library-page";
import { SkillsPage } from "../src/pages/skills-page";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const unauthenticated = { kind: "unauthenticated" } as const;
describe("empty states", () => {
  test("library teaches what will appear once the seam is real", () => {
    const markup = renderToStaticMarkup(<LibraryPage artifacts={[]} />);
    expect(markup).toContain("No artifacts yet");
    expect(markup).toContain("This workbench has no assets yet");
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
});

describe("live data", () => {
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

  test("agents disables Create when no bench is selected", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready({
          tenantId: "",
          definitions: [],
          instances: [],
          models: [],
        })}
        onAgentCreated={() => undefined}
      />,
    );
    expect(markup).toMatch(
      /disabled[^>]*>[\s\S]*Create agent|Create agent[\s\S]*disabled/,
    );
    // Dialog must not mount without a real tenant — no create form markup.
    expect(markup).not.toContain("Define a new agent");
  });
});
