// Agents roster (CL-6354): a flat table of every definition a bench owns —
// rows, never cards — with a "Workbenches" column counting how many open
// agent DMs currently run each one. `AgentsPage` is the presentational
// half (same split `LibraryPage`/`LibraryRoute` use in `pages.test.tsx`);
// no live hub here, just the render given real-shaped props.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsPage } from "../src/pages/agents-page";
import type { AgentDefinition } from "../src/agents-api";

const triage: AgentDefinition = {
  id: "wfd_1",
  tenantId: "tnt_1",
  name: "Triage bot",
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
        workbenchCounts={new Map()}
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
        workbenchCounts={new Map([["wfd_1", 3]])}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain("Triage bot");
    expect(markup).toContain("Sorts inbound issues.");
    expect(markup).toContain(">3<");
    expect(markup).not.toContain("New agent");
    expect(markup).not.toContain("Create new agent");
  });

  test("offers Create, never the retired New agent mint action", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[triage]}
        workbenchCounts={new Map()}
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
        workbenchCounts={new Map()}
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
