/// <reference types="bun" />
import "../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

type Outcome =
  | { kind: "resolve"; data: unknown }
  | { kind: "reject" }
  | { kind: "pending" };

function resolveOutcome(outcome: Outcome): Promise<unknown> {
  if (outcome.kind === "resolve") return Promise.resolve(outcome.data);
  if (outcome.kind === "reject") return Promise.reject(new Error("boom"));
  return new Promise(() => {});
}

let connectionsOutcome: Outcome = {
  kind: "resolve",
  data: { connections: [] },
};
const authorizeMock = mock(async (provider: string) => ({
  redirectUrl: `https://provider.test/authorize?p=${provider}`,
}));

import { MemoryRouter } from "react-router";

mock.module("../lib/hub-api", () => ({
  getMeConnections: () => resolveOutcome(connectionsOutcome),
  authorizeMeConnection: (provider: string) => authorizeMock(provider),
}));

const assignMock = mock((_url: string) => {});
Object.defineProperty(window, "location", {
  value: { ...window.location, assign: assignMock },
  writable: true,
});

const { MemberConnectionsPanel } = await import("./MemberConnectionsPanel");

function renderPanel(initialEntry = "/") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[initialEntry]}>
        <MemberConnectionsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  connectionsOutcome = { kind: "resolve", data: { connections: [] } };
  authorizeMock.mockClear();
  assignMock.mockClear();
});

describe("Member connections panel", () => {
  it("renders both providers from the connections map", async () => {
    connectionsOutcome = {
      kind: "resolve",
      data: {
        connections: [
          {
            provider: "linear",
            label: "Linear",
            connected: false,
            scopes: [],
            toggleEnabled: true,
            needsReconnect: false,
            configured: true,
          },
          {
            provider: "attio",
            label: "Attio",
            connected: true,
            scopes: ["read"],
            toggleEnabled: true,
            needsReconnect: false,
            configured: true,
          },
        ],
      },
    };
    renderPanel();
    await waitFor(() => expect(screen.getByText("Linear")));
    expect(screen.getByText("Attio"));
  });

  it("clicking Connect hits the authorize endpoint and redirects", async () => {
    connectionsOutcome = {
      kind: "resolve",
      data: {
        connections: [
          {
            provider: "linear",
            label: "Linear",
            connected: false,
            scopes: [],
            toggleEnabled: true,
            needsReconnect: false,
            configured: true,
          },
        ],
      },
    };
    renderPanel();
    await waitFor(() => expect(screen.getByText("Linear")));
    screen.getByRole("button", { name: "Connect" }).click();
    await waitFor(() => expect(authorizeMock).toHaveBeenCalledWith("linear"));
    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "https://provider.test/authorize?p=linear",
      ),
    );
  });

  it("disables Connect and explains when a provider is not configured", async () => {
    connectionsOutcome = {
      kind: "resolve",
      data: {
        connections: [
          {
            provider: "attio",
            label: "Attio",
            connected: false,
            scopes: [],
            toggleEnabled: true,
            needsReconnect: false,
            configured: false,
          },
        ],
      },
    };
    renderPanel();
    await waitFor(() =>
      expect(
        screen.getByText(
          "Not available — an owner must configure this provider's OAuth app on the Capabilities page.",
        ),
      ),
    );
    const button = screen.getByRole("button", {
      name: "Connect",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("shows a success banner from the connected query param", async () => {
    connectionsOutcome = { kind: "resolve", data: { connections: [] } };
    renderPanel("/?connected=linear");
    await waitFor(() =>
      expect(screen.getByText("Connected linear successfully.")),
    );
  });

  it("shows an error banner from the connect_error query param", async () => {
    connectionsOutcome = { kind: "resolve", data: { connections: [] } };
    renderPanel("/?connect_error=denied");
    await waitFor(() =>
      expect(screen.getByText("You declined the connection request.")),
    );
  });
});