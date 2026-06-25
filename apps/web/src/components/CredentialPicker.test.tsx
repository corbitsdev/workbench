/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import type { Principal } from "../lib/hub-api";

type PickerCredential = { id: string; tenantId: string; name: string };

afterEach(() => cleanup());

const principals: Principal[] = [
  {
    principalId: "p-1",
    tenantId: "t-1",
    tenantSlug: "abk-labs",
    tenantName: "ABK Labs",
    kind: "user",
    status: "active",
    roles: [],
  },
  {
    principalId: "p-2",
    tenantId: "t-2",
    tenantSlug: "user-sawyer",
    tenantName: "Sawyer",
    kind: "user",
    status: "active",
    roles: [],
  },
];

const credentialsByTenant: Record<string, PickerCredential[]> = {
  "t-1": [{ id: "cred-1", tenantId: "t-1", name: "Granola API Key" }],
  "t-2": [{ id: "cred-2", tenantId: "t-2", name: "Linear API Key" }],
};

describe("CredentialPicker", () => {
  it("renders loading state", async () => {
    const { CredentialPicker } = await import("./CredentialPicker");
    render(
      React.createElement(CredentialPicker, {
        principals: [],
        credentialsByTenant: {},
        selectedIds: [],
        onSelect: () => {},
        isLoading: true,
      }),
    );
    expect(screen.getByTestId("credential-picker-loading")).toBeDefined();
  });

  it("renders empty state when no credentials", async () => {
    const { CredentialPicker } = await import("./CredentialPicker");
    render(
      React.createElement(CredentialPicker, {
        principals: [],
        credentialsByTenant: {},
        selectedIds: [],
        onSelect: () => {},
      }),
    );
    expect(screen.getByTestId("credential-picker-empty")).toBeDefined();
  });

  it("renders credentials with tenant name in display format", async () => {
    const { CredentialPicker } = await import("./CredentialPicker");
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: [],
        onSelect: () => {},
      }),
    );
    expect(screen.getByText("Granola API Key — ABK Labs")).toBeDefined();
    expect(screen.getByText("Linear API Key — Sawyer")).toBeDefined();
  });

  it("calls onSelect with toggled credential IDs when checkbox clicked", async () => {
    const { CredentialPicker } = await import("./CredentialPicker");
    const onSelect = mock((ids: string[]) => ids);
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: [],
        onSelect,
      }),
    );
    const checkbox = screen.getByTestId(
      "credential-checkbox-cred-1",
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onSelect).toHaveBeenCalledWith(["cred-1"]);
  });

  it("reflects checked state from selectedIds", async () => {
    const { CredentialPicker } = await import("./CredentialPicker");
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: ["cred-1"],
        onSelect: () => {},
      }),
    );
    const checkbox = screen.getByTestId(
      "credential-checkbox-cred-1",
    ) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    const unchecked = screen.getByTestId(
      "credential-checkbox-cred-2",
    ) as HTMLInputElement;
    expect(unchecked.checked).toBe(false);
  });

  it("removes credential ID from selection when already checked", async () => {
    const { CredentialPicker } = await import("./CredentialPicker");
    const onSelect = mock((ids: string[]) => ids);
    render(
      React.createElement(CredentialPicker, {
        principals,
        credentialsByTenant,
        selectedIds: ["cred-1"],
        onSelect,
      }),
    );
    const checkbox = screen.getByTestId(
      "credential-checkbox-cred-1",
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onSelect).toHaveBeenCalledWith([]);
  });
});
