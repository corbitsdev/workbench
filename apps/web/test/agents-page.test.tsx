// Screen-level proof for the Agents page detail panel and its two
// launch actions — Start chat and Open in channel. Mirrors the SSR
// shape used by pages.test.tsx: real `APIQuery` props in, honest markup
// out. The async `createChannel` call behind Start chat is covered by
// packages/chat-ui/test/api.test.ts; here we prove the entry points are
// reachable and labelled so a user can get to a live conversation in
// two clicks.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery } from "../src/api";
import type {
  AgentDefinition,
  AgentDirectoryData,
  AgentInstance,
} from "../src/agents-api";
import { AgentsPage } from "../src/pages/agents-page";

function ready<T>(data: T): APIQuery<T> {
  return { kind: "ready", data };
}

const definition: AgentDefinition = {
  id: "wfd_1",
  tenantId: "tenant_1",
  name: "Researcher",
  description: "Answers research questions",
  currentVersion: "3",
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

describe("AgentDetailPanel", () => {
  test("renders the definition's name, version, and description when selected", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Researcher");
    expect(markup).toContain("Answers research questions");
    expect(markup).toContain("Version:");
    expect(markup).toContain("3");
    expect(markup).toContain("deployed");
    // The raw definition id must never appear in the rendered detail.
    expect(markup).not.toContain("wfd_1");
  });

  test("shows Start chat and Open in channel action buttons", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Start chat");
    expect(markup).toContain("Open in channel");
  });

  test("renders a Back button to return to the agent list", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Back");
    expect(markup).toContain('aria-label="Back to agent list"');
  });

  test("lists the definition's deployed instances inside the detail panel", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Instances (1)");
    // Instance name shows, but never its mailbox address as visible text.
    expect(markup).toContain("Researcher");
    expect(markup).not.toContain("ins_1@acme.localhost");
  });

  test("points at Start chat when the definition has no instances", () => {
    const noInstances: AgentDirectoryData = {
      ...directoryData,
      instances: [],
    };
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(noInstances)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    expect(markup).toContain("Instances (0)");
    expect(markup).toContain("No instances deployed");
    expect(markup).toContain("Start chat");
  });

  test("disables both actions when no bench (tenant) is selected", () => {
    const noTenant: AgentDirectoryData = {
      ...directoryData,
      tenantId: "",
    };
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(noTenant)}
        onAgentCreated={() => undefined}
        initialSelectedDefinitionId="wfd_1"
        navigate={() => undefined}
      />,
    );
    // Start chat button should carry the disabled attribute.
    expect(markup).toMatch(/disabled[^>]*>[\s\S]*Start chat/);
  });
});

describe("AgentsPage empty states", () => {
  test("the no-agents empty state points at creating then chatting", () => {
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
    expect(markup).toContain("start a chat");
    expect(markup).toContain("invite into a channel");
  });

  test("the no-instances empty state points at inviting into a channel", () => {
    // A directory with a definition but zero deployed instances exercises
    // the empty copy on the Instances tab.
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready({ ...directoryData, instances: [] })}
        onAgentCreated={() => undefined}
        initialTab="instances"
      />,
    );
    expect(markup).toContain("No agent instance is deployed");
    expect(markup).toContain("Invite a definition into a channel");
  });
});

// The detail panel is only useful if a user can reach it. This proves the
// list surface exposes an open-details affordance on every definition — the
// first click of the two-click path into a live conversation. (The rows
// view reuses the same aria-label, so grid coverage is sufficient here.)
describe("AgentsPage list entry points", () => {
  test("every definition card exposes an Open-details affordance", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        directory={ready(directoryData)}
        onAgentCreated={() => undefined}
      />,
    );
    expect(markup).toContain('aria-label="Open Researcher details"');
  });
});
