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

let searchString = "";
mock.module("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(searchString), mock(() => {})],
}));

mock.module("../lib/hub-api", () => ({
  getMeConnections: () => resolveOutcome(connectionsOutcome),
  authorizeMeConnection: (provider: string) => authorizeMock(provider),
}));

const assignMock = mock((_url: string) => {});
Object.defineProperty(window, "location", {
  value: { ...window.location, assign: assignMock },
  writable: true,
});

const { Connections } = await import("./Connections");

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Connections />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  connectionsOutcome = { kind: "resolve", data: { connections: [] } };
  searchString = "";
  authorizeMock.mockClear();
  assignMock.mockClear();
});

describe("Connections page", () => {
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
    renderPage();
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
    renderPage();
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
    renderPage();
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
    searchString = "connected=linear";
    connectionsOutcome = { kind: "resolve", data: { connections: [] } };
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Connected linear successfully.")),
    );
  });

  it("shows an error banner from the connect_error query param", async () => {
    searchString = "connect_error=denied";
    connectionsOutcome = { kind: "resolve", data: { connections: [] } };
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("You declined the connection request.")),
    );
  });
});
