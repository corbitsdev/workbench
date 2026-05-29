import { describe, it, expect, beforeEach, mock } from "bun:test";
import { createIntakeRouter } from "./intake";
import type { IntakeRequest, IntakeResponse } from "./intake";

describe("Intake router", () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      insert: mock((table) => ({
        values: mock((data) => ({
          returning: mock(() => [{ id: "test-id", ...data }]),
        })),
      })),
    };
  });

  it("POST /intake with paste source creates session and transcript", async () => {
    const router = createIntakeRouter(mockDb);
    const req = new Request("http://localhost:4000/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Speaker 1: Hello, this is a sales call",
        source: "paste",
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(200);

    const json = (await res.json()) as IntakeResponse;
    expect(json.sessionId).toBe("test-id");
    expect(json.transcriptId).toBe("test-id");
    expect(json.status).toBe("analyzing");
  });

  it("POST /intake rejects paste without transcript", async () => {
    const router = createIntakeRouter(mockDb);
    const req = new Request("http://localhost:4000/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "paste" }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect((json as any).error).toContain("transcript is required");
  });

  it("POST /intake rejects empty transcript", async () => {
    const router = createIntakeRouter(mockDb);
    const req = new Request("http://localhost:4000/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "   ",
        source: "paste",
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);

    const json = await res.json();
    expect((json as any).error).toContain("cannot be empty");
  });

  it("POST /intake rejects invalid source", async () => {
    const router = createIntakeRouter(mockDb);
    const req = new Request("http://localhost:4000/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: "Hello",
        source: "invalid",
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(400);
  });

  it("POST /intake returns 503 for granola source when not configured", async () => {
    const router = createIntakeRouter(mockDb);
    const req = new Request("http://localhost:4000/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        granolaId: "note-123",
        source: "granola",
      }),
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(503);
  });

  it("GET /recent-calls returns 503 when Granola not configured", async () => {
    const router = createIntakeRouter(mockDb);
    const req = new Request("http://localhost:4000/recent-calls", {
      method: "GET",
    });

    const res = await router.fetch(req);
    expect(res.status).toBe(503);
  });
});
