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
import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { AgentsPage } from "../src/pages/agents-page";
import { LibraryPage } from "../src/pages/library-page";
import { SettingsRoute } from "../src/pages/settings-page";
import { SkillsPage } from "../src/pages/skills-page";
import { TestQueryProvider } from "./test-query-provider";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const unauthenticated = { kind: "unauthenticated" } as const;
describe("empty states", () => {
  test("library teaches what will appear once the seam is real", () => {
    const markup = renderToStaticMarkup(<LibraryPage artifacts={[]} />);
    expect(markup).toContain("No artifacts yet");
    expect(markup).toContain(
      "Upload a file or wait for agents and workflows to produce artifacts",
    );
  });

  test("skills renders the shell with an honest empty state and a single New skill action", () => {
    const markup = renderToStaticMarkup(<SkillsPage />);
    expect(markup).toContain("No skills yet");
    expect(markup).toContain("New skill");
    expect(markup).not.toContain("Search skills");
  });

  test("skills with a session draft shows card chrome and detail", () => {
    const markup = renderToStaticMarkup(
      <SkillsPage
        skills={[
          {
            id: "skill_1",
            name: "Brief writer",
            description: "Turns notes into a research brief",
            body: "Always cite sources.",
            access: "Private",
            owner: "You",
            updatedAt: "2026-08-05T11:00:00.000Z",
            version: "0.1.0",
            pinnedBy: [],
            versions: [
              {
                version: "0.1.0",
                note: "Session draft",
                who: "You",
                whenIso: "2026-08-05T11:00:00.000Z",
                current: true,
              },
            ],
            sessionLocal: true,
          },
        ]}
        now={Date.parse("2026-08-05T12:00:00.000Z")}
      />,
    );
    expect(markup).toContain("Brief writer");
    // Search lives in shell col2; stage is detail chrome only.
    expect(markup).toContain("Version history");
    expect(markup).toContain("Pinned by");
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

  test("library with onUpload puts Upload in the top bar, not the toolbar", () => {
    const markup = renderToStaticMarkup(
      <LibraryPage artifacts={[reportArtifact]} onUpload={() => undefined} />,
    );
    // Hidden file input behind the top-bar Upload action and
    // workbench:library:upload.
    expect(markup).toContain('type="file"');
    expect(markup).toContain('aria-label="Upload artifacts"');
    expect(markup).toContain("sr-only");
    // Upload is a top-bar action (mock: primary chip in `.top`).
    expect(markup).toMatch(/stage-top-bar-actions[\s\S]*?>Upload</);
    // Sort is icon-only with an accessible name.
    expect(markup).toContain('aria-label="Newest first"');
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

  test("agents stage is detail-only: select prompt when nothing is open", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
      />,
    );
    expect(markup).toContain("Select an agent");
    expect(markup).not.toContain("wfd_1");
  });

  test("agents detail never renders an instance's mailbox address as visible text", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).not.toContain("ins_1@acme.localhost");
  });

  test("agents detail lists instances for the selected definition", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Instances (1)");
    expect(markup).toContain("Answers research questions");
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
    // Create lives on pageBand / dialog; without a tenant the dialog does not mount.
    expect(markup).not.toContain("Define a new agent");
  });
});

describe("settings top bar", () => {
  test("titles the bar with the active section", () => {
    const markup = renderToStaticMarkup(
      <TestQueryProvider>
        <NavigationProvider navigate={() => undefined}>
          <BenchProvider>
            <SettingsRoute />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(markup).toContain("Settings · Your agent");
  });
});
