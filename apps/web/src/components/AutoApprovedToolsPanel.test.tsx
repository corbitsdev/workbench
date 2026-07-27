/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutoApprovedTool } from "../lib/approvals-api";

const mockList = mock(async (): Promise<AutoApprovedTool[]> => []);
const mockRevoke = mock(async () => {});

mock.module("../lib/approvals-api", () => ({
  listAutoApprovedTools: mockList,
  revokeAutoApprovedTool: mockRevoke,
}));

const { AutoApprovedToolsPanel } = await import("./AutoApprovedToolsPanel");

afterEach(() => {
  cleanup();
  mockList.mockReset();
  mockRevoke.mockReset();
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AutoApprovedToolsPanel tenantId="tenant-1" />
    </QueryClientProvider>,
  );
}

function row(overrides: Partial<AutoApprovedTool> = {}): AutoApprovedTool {
  return {
    id: "aat-1",
    tenantId: "tenant-1",
    principalId: "prn-1",
    toolName: "slack__post_message",
    createdByPrincipalId: "prn-member",
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("AutoApprovedToolsPanel", () => {
  it("shows an empty state when there are no auto-approved tools", async () => {
    mockList.mockResolvedValue([]);
    renderPanel();
    await waitFor(() => {
      screen.getByText(/no always-approved actions/i);
    });
  });

  it("lists a friendly label for each auto-approved tool", async () => {
    mockList.mockResolvedValue([row()]);
    renderPanel();
    await waitFor(() => {
      screen.getByText("Post message (Slack)");
    });
  });

  it("revokes a tool on click", async () => {
    mockList.mockResolvedValue([row()]);
    renderPanel();
    await waitFor(() => {
      screen.getByTestId("revoke-auto-approved-aat-1");
    });
    fireEvent.click(screen.getByTestId("revoke-auto-approved-aat-1"));
    await waitFor(() => {
      expect(mockRevoke).toHaveBeenCalledWith("tenant-1", "aat-1");
    });
  });
});
