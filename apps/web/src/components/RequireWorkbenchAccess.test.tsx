import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { RequireWorkbenchAccess } from "./RequireWorkbenchAccess";

const useActiveWorkbench = mock(() => ({
  workbenches: [] as { tenantId: string; slug: string; name: string }[],
  loading: false,
}));

mock.module("../lib/active-workbench-context", () => ({
  useActiveWorkbench,
}));

const signOut = mock(() => Promise.resolve());
mock.module("../components/AuthProvider", () => ({
  useAuth: () => ({
    session: {
      status: "authenticated" as const,
      user: { name: "Alex", email: "alex@example.com" },
    },
    signOut,
  }),
}));

afterEach(() => {
  cleanup();
  useActiveWorkbench.mockReset();
});

describe("RequireWorkbenchAccess", () => {
  it("shows the welcome screen when the user has no workbenches", () => {
    useActiveWorkbench.mockReturnValue({
      workbenches: [],
      loading: false,
    });
    render(
      <RequireWorkbenchAccess>
        <div>App content</div>
      </RequireWorkbenchAccess>,
    );
    expect(screen.getByText(/No workbench access yet/i)).toBeTruthy();
    expect(screen.queryByText("App content")).toBeNull();
  });

  it("renders children when workbenches exist", () => {
    useActiveWorkbench.mockReturnValue({
      workbenches: [{ tenantId: "tnt_1", slug: "gtm", name: "GTM" }],
      loading: false,
    });
    render(
      <RequireWorkbenchAccess>
        <div>App content</div>
      </RequireWorkbenchAccess>,
    );
    expect(screen.getByText("App content")).toBeTruthy();
  });
});
