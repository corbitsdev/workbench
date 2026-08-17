import { describe, expect, test } from "bun:test";

import { connectorStatus } from "./connections-status";
import type { Credential, Provider } from "./credentials-api";

// The backend always names a provider row after the connector's
// lowercase id (`ensureProvider({ name: descriptor.id, ... })`) — never
// its display label — so every fixture here mirrors that: "linear", not
// "Linear".
function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-1",
    name: "linear",
    plugin: "linear",
    ...overrides,
  } as Provider;
}

function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    tenantId: "tenant-1",
    providerId: "provider-1",
    name: "Linear",
    type: "api_key",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Credential;
}

describe("connectorStatus", () => {
  test("not_connected when no provider matches the connector's id", () => {
    const result = connectorStatus("linear", [], []);
    expect(result.status).toBe("not_connected");
  });

  test("not_connected when a provider exists but no credential points at it", () => {
    const result = connectorStatus("linear", [], [provider()]);
    expect(result.status).toBe("not_connected");
  });

  test("connected when the newest credential is active", () => {
    const result = connectorStatus(
      "linear",
      [credential({ status: "active" })],
      [provider()],
    );
    expect(result.status).toBe("connected");
  });

  test("needs_attention when the newest credential is expired", () => {
    const result = connectorStatus(
      "linear",
      [credential({ status: "expired" })],
      [provider()],
    );
    expect(result.status).toBe("needs_attention");
  });

  test("needs_attention when the newest credential is in error", () => {
    const result = connectorStatus(
      "linear",
      [credential({ status: "error" })],
      [provider()],
    );
    expect(result.status).toBe("needs_attention");
  });

  test("not_connected when the newest credential is revoked", () => {
    const result = connectorStatus(
      "linear",
      [credential({ status: "revoked" })],
      [provider()],
    );
    expect(result.status).toBe("not_connected");
  });

  test("picks the credential with the newest createdAt when more than one exists", () => {
    const older = credential({
      id: "cred-old",
      status: "expired",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const newer = credential({
      id: "cred-new",
      status: "active",
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const result = connectorStatus("linear", [older, newer], [provider()]);
    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      expect(result.credential.id).toBe("cred-new");
    }
  });

  test("ignores credentials belonging to a different provider", () => {
    const other = credential({ providerId: "provider-2", status: "active" });
    const result = connectorStatus("linear", [other], [provider()]);
    expect(result.status).toBe("not_connected");
  });

  // Regression for the bug where the card grid matched on
  // `descriptor.displayName` ("Linear", "Ollama") against a provider row
  // the backend always names by lowercase id ("linear", "ollama") — every
  // card read "not connected" forever, no matter how many times a person
  // reconnected. A caller passing the display label instead of the id
  // must never match.
  test("a connector's display name never matches its own provider row", () => {
    const result = connectorStatus(
      "Linear",
      [credential({ status: "active" })],
      [provider()],
    );
    expect(result.status).toBe("not_connected");
  });
});
