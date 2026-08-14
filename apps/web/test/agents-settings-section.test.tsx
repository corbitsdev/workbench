// Settings · Agents (CL-5990): definitions only. The section fetches its
// own directory (`useAgentDirectory`), so these tests mount through a
// seeded QueryClient the way `settings-page.test.tsx` seeds its bench probe
// — never render-to-string, since the fetch happens in an effect.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";

import type {
  AgentDefinition,
  AgentDirectoryData,
  AgentInstance,
} from "../src/agents-api";
import { AgentsSettingsSection } from "../src/pages/agents-settings-section";
import { tenantKeys } from "../src/query-client";
import { TestQueryProvider } from "./test-query-provider";

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

function seededClient(data: AgentDirectoryData): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
    },
  });
  client.setQueryData(tenantKeys.agentDirectory("tenant_1"), data);
  return client;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(
  data: AgentDirectoryData,
  props: {
    readonly entityId?: string | null;
    readonly navigate?: (to: string) => void;
  } = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider client={seededClient(data)}>
        <AgentsSettingsSection tenantId="tenant_1" {...props} />
      </TestQueryProvider>,
    );
  });
  return container;
}

describe("AgentsSettingsSection", () => {
  test("no bench selected shows an honest empty state", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const r = createRoot(el);
    await act(async () => {
      r.render(
        <TestQueryProvider>
          <AgentsSettingsSection tenantId={null} />
        </TestQueryProvider>,
      );
    });
    expect(el.textContent).toContain("No bench selected");
    act(() => r.unmount());
    el.remove();
  });

  test("lists definitions when nothing is selected", async () => {
    const el = await mount(directoryData);
    expect(el.textContent).toContain("Researcher");
    expect(el.textContent).toContain("New agent");
  });

  test("selecting via entityId shows the detail panel with instances", async () => {
    const el = await mount(directoryData, { entityId: "wfd_1" });
    expect(el.textContent).toContain("Researcher");
    expect(el.textContent).toContain("Answers research questions");
    expect(el.textContent).toContain("Instances (1)");
    expect(el.textContent).toContain("Start chat");
    expect(el.textContent).toContain("Open in channel");
    expect(el.innerHTML).not.toContain("ins_1@acme.localhost");
  });

  test("navigate is called with the section sub-path when a row is selected", async () => {
    const navigated: string[] = [];
    const el = await mount(directoryData, {
      navigate: (to) => navigated.push(to),
    });
    const row = Array.from(el.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Researcher"),
    );
    expect(row).toBeDefined();
    await act(async () => {
      row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toContain("/settings/agents/wfd_1");
  });

  test("no agents yet shows the create-oriented empty state", async () => {
    const el = await mount({
      tenantId: "tenant_1",
      definitions: [],
      instances: [],
      models: [],
    });
    expect(el.textContent).toContain("No agents yet");
  });
});
