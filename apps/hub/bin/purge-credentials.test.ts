import { describe, it, expect } from "bun:test";
import { listCredentials, listProviders } from "./purge-credentials";

describe("purge-credentials exports", () => {
  it("exports listCredentials and listProviders", () => {
    expect(typeof listCredentials).toBe("function");
    expect(typeof listProviders).toBe("function");
  });
});
