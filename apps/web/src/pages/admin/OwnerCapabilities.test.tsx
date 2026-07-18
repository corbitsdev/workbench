/// <reference types="bun" />
import "../../test-setup";
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

mock.module("react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) =>
    React.createElement("a", { href: to }, children as React.ReactNode),
}));

type Outcome =
  | { kind: "resolve"; data: unknown }
  | { kind: "reject" }
  | { kind: "pending" };

let credentialsOutcome: Outcome = { kind: "resolve", data: [] };
let featuresOutcome: Outcome = { kind: "resolve", data: { features: [] } };
let oauthCapabilitiesOutcome: Outcome = {
  kind: "resolve",
  data: { capabilities: [] },
};
let inboxSourcesOutcome: Outcome = { kind: "resolve", data: { sources: [] } };
const setOwnerFeatureEnabledMock = mock(
  async (name: string, enabled: boolean) => ({ name, enabled }),
);
const setOwnerInboxSourceEnabledMock = mock(
  async (key: string, enabled: boolean) => ({ key, enabled }),
);
const setOwnerCapabilityEnabledMock = mock(
  async (provider: string, enabled: boolean) => ({ provider, enabled }),
);

function resolveOutcome(outcome: Outcome): Promise<unknown> {
  if (outcome.kind === "resolve") return Promise.resolve(outcome.data);
  if (outcome.kind === "reject") return Promise.reject(new Error("boom"));
  return new Promise(() => {});
}

mock.module("../../lib/hub-api", () => ({
  getOwnerCredentials: () => resolveOutcome(credentialsOutcome),
  setOwnerCredential: () => Promise.reject(new Error("not used in this test")),
  clearOwnerCredential: () =>
    Promise.reject(new Error("not used in this test")),
  getOwnerFeatures: () => resolveOutcome(featuresOutcome),
  setOwnerFeatureEnabled: (name: string, enabled: boolean) =>
    setOwnerFeatureEnabledMock(name, enabled),
  getOwnerCapabilities: () => resolveOutcome(oauthCapabilitiesOutcome),
  setOwnerCapabilityEnabled: (provider: string, enabled: boolean) =>
    setOwnerCapabilityEnabledMock(provider, enabled),
  getOwnerInboxSources: () => resolveOutcome(inboxSourcesOutcome),
  setOwnerInboxSourceEnabled: (key: string, enabled: boolean) =>
    setOwnerInboxSourceEnabledMock(key, enabled),
}));

import { OwnerCapabilities } from "./OwnerCapabilities";

function renderCapabilities() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <OwnerCapabilities />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  credentialsOutcome = { kind: "resolve", data: [] };
  featuresOutcome = { kind: "resolve", data: { features: [] } };
  oauthCapabilitiesOutcome = { kind: "resolve", data: { capabilities: [] } };
  inboxSourcesOutcome = { kind: "resolve", data: { sources: [] } };
  setOwnerFeatureEnabledMock.mockClear();
  setOwnerCapabilityEnabledMock.mockClear();
  setOwnerInboxSourceEnabledMock.mockClear();
});

describe("OwnerCapabilities", () => {
  it("lists integrations, each linking to its own sub-page", () => {
    renderCapabilities();
    expect(screen.getByText("Gamma"));
    const link = Array.from(document.querySelectorAll("a")).find((a) =>
      a.textContent?.includes("Gamma"),
    );
    expect(link?.getAttribute("href")).toBe(
      "/settings/owner/capabilities/gamma",
    );
  });

  it("lists only tool-kind credentials, never a secret value", async () => {
    credentialsOutcome = {
      kind: "resolve",
      data: [
        {
          providerName: "anthropic",
          label: "Anthropic",
          kind: "inference",
          configured: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          providerName: "granola",
          label: "Granola",
          kind: "tool",
          configured: true,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Granola")));
    expect(screen.queryByText("Anthropic")).toBeNull();
    expect(document.body.innerHTML).not.toContain("gr-super-secret");
  });

  it("lists feature grants with their enablement state", async () => {
    featuresOutcome = {
      kind: "resolve",
      data: {
        features: [
          {
            name: "scheduler",
            label: "Automation scheduler",
            description: "Fires durable scheduled triggers.",
            enabled: false,
            forcedByEnv: false,
            principalId: null,
          },
        ],
      },
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Automation scheduler")));
    expect(screen.getByText("Disabled"));
    expect(screen.getByText("Enable"));
  });

  it("disables the toggle and explains when a feature is forced on by env", async () => {
    featuresOutcome = {
      kind: "resolve",
      data: {
        features: [
          {
            name: "triage",
            label: "Mailbox triage",
            description: "Ephemeral Myra triage.",
            enabled: false,
            forcedByEnv: true,
            principalId: null,
          },
        ],
      },
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Mailbox triage")));
    expect(screen.getByText("Forced on by the deployment"));
    const button = screen.getByRole("button", {
      name: "Enable",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("toggles a feature on click, calling the hub API with the flipped state", async () => {
    featuresOutcome = {
      kind: "resolve",
      data: {
        features: [
          {
            name: "scheduler",
            label: "Automation scheduler",
            description: "Fires durable scheduled triggers.",
            enabled: false,
            forcedByEnv: false,
            principalId: null,
          },
        ],
      },
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Automation scheduler")));
    screen.getByRole("button", { name: "Enable" }).click();
    await waitFor(() =>
      expect(setOwnerFeatureEnabledMock).toHaveBeenCalledWith(
        "scheduler",
        true,
      ),
    );
  });

  it("lists inbox sources and toggles one, calling the hub API with the flipped state", async () => {
    inboxSourcesOutcome = {
      kind: "resolve",
      data: {
        sources: [
          {
            key: "granola",
            label: "Granola",
            description: "Call notes from meetings.",
            enabled: true,
          },
        ],
      },
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Granola")));
    expect(screen.getByText("Inbox sources"));
    screen.getByRole("button", { name: "Disable" }).click();
    await waitFor(() =>
      expect(setOwnerInboxSourceEnabledMock).toHaveBeenCalledWith(
        "granola",
        false,
      ),
    );
  });

  it("optimistically flips the inbox source status label before the mutation resolves, and rolls back on failure", async () => {
    inboxSourcesOutcome = {
      kind: "resolve",
      data: {
        sources: [
          {
            key: "granola",
            label: "Granola",
            description: "Call notes from meetings.",
            enabled: true,
          },
        ],
      },
    };
    let resolveToggle: (() => void) | undefined;
    setOwnerInboxSourceEnabledMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          resolveToggle = () => reject(new Error("boom"));
        }),
    );
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Granola")));
    screen.getByRole("button", { name: "Disable" }).click();

    await waitFor(() => expect(screen.getByText("Disabled")));

    resolveToggle?.();
    await waitFor(() => expect(screen.getByText("Enabled")));
    expect(
      screen.getByText(
        "Could not update the inbox source. Try again in a moment.",
      ),
    ).toBeDefined();
  });

  it("only disables the feature row whose toggle is in flight, not every row", async () => {
    featuresOutcome = {
      kind: "resolve",
      data: {
        features: [
          {
            name: "scheduler",
            label: "Automation scheduler",
            description: "Fires durable scheduled triggers.",
            enabled: false,
            forcedByEnv: false,
            principalId: null,
          },
          {
            name: "triage",
            label: "Mailbox triage",
            description: "Ephemeral Myra triage.",
            enabled: false,
            forcedByEnv: false,
            principalId: null,
          },
        ],
      },
    };
    let resolveToggle: (() => void) | undefined;
    setOwnerFeatureEnabledMock.mockImplementationOnce(
      (name: string, enabled: boolean) =>
        new Promise((resolve) => {
          resolveToggle = () => resolve({ name, enabled });
        }),
    );
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Automation scheduler")));

    const enableButtons = () =>
      screen.getAllByRole("button", { name: "Enable" }) as HTMLButtonElement[];
    const [schedulerBtn, triageBtn] = enableButtons();
    schedulerBtn.click();

    await waitFor(() => expect(schedulerBtn.disabled).toBe(true));
    expect(triageBtn.disabled).toBe(false);

    resolveToggle?.();
    await waitFor(() => expect(schedulerBtn.disabled).toBe(false));
  });

  it("only disables the inbox source row whose toggle is in flight, not every row", async () => {
    inboxSourcesOutcome = {
      kind: "resolve",
      data: {
        sources: [
          {
            key: "granola",
            label: "Granola",
            description: "Call notes from meetings.",
            enabled: true,
          },
          {
            key: "gmail",
            label: "Gmail",
            description: "Email intake.",
            enabled: true,
          },
        ],
      },
    };
    let resolveToggle: (() => void) | undefined;
    setOwnerInboxSourceEnabledMock.mockImplementationOnce(
      (key: string, enabled: boolean) =>
        new Promise((resolve) => {
          resolveToggle = () => resolve({ key, enabled });
        }),
    );
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Granola")));

    const disableButtons = () =>
      screen.getAllByRole("button", {
        name: "Disable",
      }) as HTMLButtonElement[];
    const [granolaBtn, gmailBtn] = disableButtons();
    granolaBtn.click();

    await waitFor(() => expect(granolaBtn.disabled).toBe(true));
    expect(gmailBtn.disabled).toBe(false);

    resolveToggle?.();
    await waitFor(() => expect(granolaBtn.disabled).toBe(false));
  });

  it("only disables the OAuth capability row whose toggle is in flight, not every row", async () => {
    oauthCapabilitiesOutcome = {
      kind: "resolve",
      data: {
        capabilities: [
          { provider: "linear", label: "Linear", enabled: true },
          { provider: "github", label: "GitHub", enabled: true },
        ],
      },
    };
    let resolveToggle: (() => void) | undefined;
    setOwnerCapabilityEnabledMock.mockImplementationOnce(
      (provider: string, enabled: boolean) =>
        new Promise((resolve) => {
          resolveToggle = () => resolve({ provider, enabled });
        }),
    );
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Linear")));

    const hideButtons = () =>
      screen.getAllByRole("button", { name: "Hide" }) as HTMLButtonElement[];
    const [linearBtn, githubBtn] = hideButtons();
    linearBtn.click();

    await waitFor(() => expect(linearBtn.disabled).toBe(true));
    expect(githubBtn.disabled).toBe(false);

    resolveToggle?.();
    await waitFor(() => expect(linearBtn.disabled).toBe(false));
  });

  it("toggles an OAuth capability on click, calling the hub API with the flipped state", async () => {
    oauthCapabilitiesOutcome = {
      kind: "resolve",
      data: {
        capabilities: [{ provider: "linear", label: "Linear", enabled: true }],
      },
    };
    renderCapabilities();
    await waitFor(() => expect(screen.getByText("Linear")));
    expect(screen.getByText("Enabled"));
    screen.getByRole("button", { name: "Hide" }).click();
    await waitFor(() =>
      expect(setOwnerCapabilityEnabledMock).toHaveBeenCalledWith(
        "linear",
        false,
      ),
    );
  });
});
