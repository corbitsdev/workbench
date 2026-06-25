import { describe, it, expect } from "bun:test";
import { createSystemRouter } from "./system";

describe("GET /health", () => {
  it("returns 200 with an empty body (pure liveness)", async () => {
    const app = createSystemRouter("abc1234");
    const res = await app.request("/health");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({});
  });

  it("does not leak the build SHA on the liveness probe", async () => {
    const app = createSystemRouter("abc1234");
    const res = await app.request("/health");
    const body = (await res.json()) as Record<string, unknown>;

    expect("buildSha" in body).toBe(false);
  });
});
