// Agents roster (CL-6354): a flat table of every definition a bench owns —
// rows, never cards — with a "Workbenches" column counting how many open
// agent DMs currently run each one. `AgentsPage` is the presentational
// half (same split `LibraryPage`/`LibraryRoute` use in `pages.test.tsx`);
// no live hub here, just the render given real-shaped props.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsPage } from "../src/pages/agents-page";
import type { AgentDefinitionWithDisplayName } from "../src/agents-directory";

// `name` is the immutable kebab identifier; `displayName` is what
// `withDisplayNames` (CL-6413) derives from the definition's description
// (or, absent one, a humanized reading of `name`) — the page renders both,
// never the slug alone.
const triage: AgentDefinitionWithDisplayName = {
  id: "wfd_1",
  tenantId: "tnt_1",
  name: "triage-bot",
  displayName: "Triage bot",
  description: "Sorts inbound issues.",
  currentVersion: "v1",
  status: "deployed",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const noop = () => undefined;

describe("AgentsPage", () => {
  test("teaches what will appear once a bench has no agents yet", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[]}
        workbenches={new Map()}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain("No agents yet");
  });

  test("renders one row per definition with its workbench count", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={
          new Map([
            [
              "wfd_1",
              [
                { id: "wb_1", title: "Growth" },
                { id: "wb_2", title: "Support" },
                { id: "wb_3", title: "Launch" },
              ],
            ],
          ])
        }
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain("Triage bot");
    expect(markup).toContain("triage-bot");
    expect(markup).toContain("Sorts inbound issues.");
    expect(markup).toContain(">3<");
    expect(markup).not.toContain("New agent");
    expect(markup).not.toContain("Create new agent");
  });

  test("renders a humanized display name for a definition with no description, alongside its slug", () => {
    const undescribed: AgentDefinitionWithDisplayName = {
      ...triage,
      id: "wfd_undescribed",
      name: "research-analyst",
      displayName: "Research Analyst",
      description: null,
    };
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[undescribed]}
        workbenches={new Map()}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain("Research Analyst");
    expect(markup).toContain("research-analyst");
  });

  test("selecting a definition links each workbench instance to its own settings Agents tab", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={
          new Map([
            [
              "wfd_1",
              [
                { id: "wb_1", title: "Growth" },
                { id: "wb_2", title: "Support" },
              ],
            ],
          ])
        }
        selectedId="wfd_1"
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain('href="/w/wb_1/settings/agents"');
    expect(markup).toContain('href="/w/wb_2/settings/agents"');
    expect(markup).toContain(">Growth<");
    expect(markup).toContain(">Support<");
  });

  test("offers Create, never the retired New agent mint action", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain('aria-label="Create an agent"');
  });

  test("no create affordance without a resolved bench", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId={null}
        definitions={[]}
        workbenches={new Map()}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).not.toContain('aria-label="Create an agent"');
  });
});
