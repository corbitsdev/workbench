/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const useDefinitionDetail = mock((_kind: unknown, _key: unknown) => ({
  data: {
    definition: {
      kind: "workflow" as const,
      key: "brief-builder",
      name: "Brief Builder",
      version: "3",
      status: "running",
      description: "Turns calls into briefs.",
      deploymentCount: 2,
      createdAt: "2026-01-02T00:00:00.000Z",
    },
    deployments: [
      {
        deploymentId: "ses_new",
        status: "running",
        version: "3",
        sha: "abc1234",
        label: "prod",
        createdAt: "2026-01-02T00:00:00.000Z",
      },
      {
        deploymentId: "ses_old",
        status: "superseded",
        version: "2",
        sha: "def5678",
        label: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  },
  isLoading: false,
  isError: false,
}));

mock.module("../../hooks/use-admin", () => ({ useDefinitionDetail }));

import { DefinitionDetail } from "./DefinitionDetail";

function renderAt(entry: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/settings/admin/definitions/:key"
            element={<DefinitionDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useDefinitionDetail.mockClear();
});

describe("DefinitionDetail", () => {
  it("loads the definition addressed by the route key + kind query", () => {
    renderAt("/settings/admin/definitions/brief-builder?kind=workflow");
    expect(useDefinitionDetail).toHaveBeenLastCalledWith(
      "workflow",
      "brief-builder",
    );
  });

  it("breadcrumb links back to the bare Definitions tab when no ?back= is present", () => {
    renderAt("/settings/admin/definitions/brief-builder?kind=workflow");
    const crumb = screen.getByText("Definitions");
    expect(crumb.closest("a")?.getAttribute("href")).toBe(
      "/settings/admin/definitions",
    );
  });

  it("breadcrumb back link restores the origin page + filters from ?back=", () => {
    const back = encodeURIComponent("page=2&kind=agent&search=my");
    renderAt(
      `/settings/admin/definitions/brief-builder?kind=workflow&back=${back}`,
    );
    const href = screen
      .getByText("Definitions")
      .closest("a")
      ?.getAttribute("href");
    const [path, query] = (href ?? "").split("?");
    expect(path).toBe("/settings/admin/definitions");
    const restored = new URLSearchParams(query);
    expect(restored.get("page")).toBe("2");
    expect(restored.get("kind")).toBe("agent");
    expect(restored.get("search")).toBe("my");
  });

  it("shows the workflow deployment history rows", () => {
    renderAt("/settings/admin/definitions/brief-builder?kind=workflow");
    expect(screen.getByText("ses_new").textContent).toBe("ses_new");
    expect(screen.getByText("ses_old").textContent).toBe("ses_old");
  });
});
