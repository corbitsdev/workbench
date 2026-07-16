import { describe, expect, test } from "bun:test";
import type { BaseEnv } from "@intx/agent";
import { notion } from "./interchange-tools";

describe("notion interchange tool factory", () => {
  test("throws a ToolCredentialMissingError for the notion provider when the credential env key is absent", () => {
    let caught: unknown;
    try {
      notion({} as BaseEnv);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & { providerName?: string };
    expect(err.name).toBe("ToolCredentialMissingError");
    expect(err.providerName).toBe("notion");
  });
});
