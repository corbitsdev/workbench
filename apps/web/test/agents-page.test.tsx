// Agents roster (CL-6354, CL-6469): a flat table of every definition a
// bench owns — rows, never cards — with Status/Model/Runs·7d columns and a
// bulk-select bar. `AgentsPage` is the presentational half (same split
// `LibraryPage`/`LibraryRoute` use in `pages.test.tsx`); no live hub here,
// just the render given real-shaped props.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentsPage,
  agentRosterStatus,
  runsInLast7Days,
} from "../src/pages/agents-page";
import type { AgentDefinitionWithDisplayName } from "../src/agents-directory";
import type { AgentInstance } from "../src/agents-api";

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

function instance(
  overrides: Partial<AgentInstance> & { readonly definitionId: string },
): AgentInstance {
  return {
    id: "run_1",
    definitionName: "triage-bot",
    tenantId: "tnt_1",
    address: "run_1@bench",
    status: "running",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

const NOW = new Date("2026-08-20T00:00:00.000Z").getTime();

const noop = () => undefined;

describe("agentRosterStatus", () => {
  test("a stopped definition always reads Archived, regardless of its instances", () => {
    expect(
      agentRosterStatus(
        { ...triage, status: "stopped" },
        [instance({ definitionId: "wfd_1", status: "running" })],
      ),
    ).toBe("archived");
  });

  test("a deployed definition with a running instance reads Running", () => {
    expect(
      agentRosterStatus(triage, [
        instance({ definitionId: "wfd_1", status: "running" }),
      ]),
    ).toBe("running");
  });

  test("a deployed definition with only an erroring instance reads Blocked", () => {
    expect(
      agentRosterStatus(triage, [
        instance({ definitionId: "wfd_1", status: "error" }),
      ]),
    ).toBe("blocked");
  });

  test("a deployed definition with no live instances reads Idle", () => {
    expect(agentRosterStatus(triage, [])).toBe("idle");
  });
});

describe("runsInLast7Days", () => {
  test("counts only this definition's instances created within the trailing week", () => {
    const instances = [
      instance({
        definitionId: "wfd_1",
        createdAt: "2026-08-19T00:00:00.000Z",
      }),
      instance({
        definitionId: "wfd_1",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      instance({
        definitionId: "wfd_other",
        createdAt: "2026-08-19T00:00:00.000Z",
      }),
    ];
    expect(runsInLast7Days("wfd_1", instances, NOW)).toBe(1);
  });
});

describe("AgentsPage", () => {
  test("teaches what will appear once a bench has no agents yet", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("No agents yet");
  });

  test("renders one row per definition with its status, name, and slug", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[
          instance({ definitionId: "wfd_1", status: "running" }),
        ]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain("Triage bot");
    expect(markup).toContain("triage-bot");
    expect(markup).toContain("Sorts inbound issues.");
    expect(markup).toContain("Running");
    // Running carries the live dot (react-ui's StatusDot, `live` prop) —
    // the spec's liveness marker for an actively-running agent.
    expect(markup).toContain('aria-label="Live"');
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
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
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
        instances={[]}
        now={NOW}
        selectedId="wfd_1"
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('href="/w/wb_1/settings/agents"');
    expect(markup).toContain('href="/w/wb_2/settings/agents"');
    expect(markup).toContain(">Growth<");
    expect(markup).toContain(">Support<");
  });

  test("offers New agent as the top-bar create action, per the top-nav page-action contract", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('aria-label="Create an agent"');
    expect(markup).toContain("New agent");
  });

  test("no create affordance without a resolved bench", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId={null}
        definitions={[]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).not.toContain('aria-label="Create an agent"');
  });

  test("carries a selection checkbox per row and a header select-all, but no bulk bar with nothing selected", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenches={new Map()}
        instances={[]}
        now={NOW}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
        onArchiveSelected={noop}
      />,
    );
    expect(markup).toContain('aria-label="Select all agents"');
    expect(markup).toContain('aria-label="Select Triage bot"');
    // BulkActionBar renders nothing at count 0 — none of its labels should
    // leak into the page while nothing is selected.
    expect(markup).not.toContain("Duplicate");
    expect(markup).not.toContain("Move");
    expect(markup).not.toContain("Delete");
    expect(markup).not.toContain("data-bulk-action");
  });
});
