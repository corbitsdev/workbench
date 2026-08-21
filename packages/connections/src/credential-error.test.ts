import { describe, expect, test } from "bun:test";

import { MissingCredentialError } from "./credential-error";

describe("MissingCredentialError", () => {
  test("names the connector by its consumer-facing display name", () => {
    const error = new MissingCredentialError("github");

    expect(error.name).toBe("MissingCredentialError");
    expect(error.connectorId).toBe("github");
    expect(error.displayName).toBe("GitHub");
    expect(error.message).toBe("GitHub is not connected.");
  });

  test("falls back to the raw connector id when it has no registry entry", () => {
    const error = new MissingCredentialError("not-a-real-connector");

    expect(error.connectorId).toBe("not-a-real-connector");
    expect(error.displayName).toBe("not-a-real-connector");
    expect(error.message).toBe("not-a-real-connector is not connected.");
  });
});
