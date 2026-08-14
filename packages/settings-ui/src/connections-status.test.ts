import { describe, expect, test } from "bun:test";

import { connectorStatus } from "./connections-status";
import type { Credential, Provider } from "./credentials-api";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "provider-1",
    name: "Linear",
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
  test("not_connected when no provider matches the connector's display name", () => {
    const result = connectorStatus("Linear", [], []);
    expect(result.status).toBe("not_connected");
  });

  test("not_connected when a provider exists but no credential points at it", () => {
    const result = connectorStatus("Linear", [], [provider()]);
    expect(result.status).toBe("not_connected");
  });

  test("connected when the newest credential is active", () => {
    const result = connectorStatus(
      "Linear",
      [credential({ status: "active" })],
      [provider()],
    );
    expect(result.status).toBe("connected");
  });

  test("needs_attention when the newest credential is expired", () => {
    const result = connectorStatus(
      "Linear",
      [credential({ status: "expired" })],
      [provider()],
    );
    expect(result.status).toBe("needs_attention");
  });

  test("needs_attention when the newest credential is in error", () => {
    const result = connectorStatus(
      "Linear",
      [credential({ status: "error" })],
      [provider()],
    );
    expect(result.status).toBe("needs_attention");
  });

  test("not_connected when the newest credential is revoked", () => {
    const result = connectorStatus(
      "Linear",
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
    const result = connectorStatus("Linear", [older, newer], [provider()]);
    expect(result.status).toBe("connected");
    if (result.status === "connected") {
      expect(result.credential.id).toBe("cred-new");
    }
  });

  test("ignores credentials belonging to a different provider", () => {
    const other = credential({ providerId: "provider-2", status: "active" });
    const result = connectorStatus("Linear", [other], [provider()]);
    expect(result.status).toBe("not_connected");
  });
});
