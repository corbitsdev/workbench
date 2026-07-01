import { describe, expect, it, mock } from "bun:test";

const updateDisplayName = mock(async () => {});
mock.module("../lib/display-name", () => ({ updateDisplayName }));

import { Hono } from "hono";
import { createMeProfileRouter } from "./me-profile";
import type { AuthUserUpdater } from "../lib/display-name";

function mountApp() {
  const v1 = new Hono<{ Variables: { userId: string } }>();
  v1.use((c, next) => {
    c.set("userId", c.req.header("x-test-user-id") ?? "user-1");
    return next();
  });
  v1.route("/", createMeProfileRouter({} as unknown as AuthUserUpdater));
  const app = new Hono();
  app.route("/api/v1", v1);
  return app;
}

function patch(body: unknown): Request {
  return new Request("http://localhost/api/v1/me/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-test-user-id": "user-1" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/me/profile", () => {
  it("persists the display name and echoes it back as userName", async () => {
    updateDisplayName.mockClear();
    const res = await mountApp().request(patch({ displayName: "Sawyer" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userName: "Sawyer" });
    expect(updateDisplayName).toHaveBeenCalledTimes(1);
    expect((updateDisplayName.mock.calls[0] as unknown[])[1]).toBe("Sawyer");
  });

  it("trims surrounding whitespace before persisting", async () => {
    updateDisplayName.mockClear();
    const res = await mountApp().request(patch({ displayName: "  Sawyer  " }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userName: "Sawyer" });
    expect((updateDisplayName.mock.calls[0] as unknown[])[1]).toBe("Sawyer");
  });

  it("returns 400 and does not persist when the name is missing", async () => {
    updateDisplayName.mockClear();
    const res = await mountApp().request(patch({}));
    expect(res.status).toBe(400);
    expect(updateDisplayName).not.toHaveBeenCalled();
  });

  it("returns 400 and does not persist when the name is whitespace-only", async () => {
    updateDisplayName.mockClear();
    const res = await mountApp().request(patch({ displayName: "   " }));
    expect(res.status).toBe(400);
    expect(updateDisplayName).not.toHaveBeenCalled();
  });

  it("returns 400 when the name exceeds the length ceiling", async () => {
    updateDisplayName.mockClear();
    const res = await mountApp().request(
      patch({ displayName: "x".repeat(201) }),
    );
    expect(res.status).toBe(400);
    expect(updateDisplayName).not.toHaveBeenCalled();
  });
});
