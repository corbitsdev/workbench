import { describe, expect, it } from "bun:test";
import { createDB } from "@intx/db";
import { eq } from "drizzle-orm";
import app from "../index";
import { transcript, workbenchSession } from "../db/schema";

const dbConfig = {
  host: process.env["DB_HOST"] ?? "localhost",
  port: Number(process.env["DB_PORT"] ?? "5433"),
  user: process.env["DB_USER"] ?? "workbench",
  password: process.env["DB_PASSWORD"] ?? "workbench-dev-password",
  database: process.env["DB_NAME"] ?? "workbench",
};

const { db, close } = createDB(dbConfig);

describe("POST /analyze", () => {
  it("creates a session and returns sessionId", async () => {
    const response = await app.request("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: "Test transcript content" }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.sessionId).toBeString();
    expect(body.painPoints).toEqual([]);
    expect(body.status).toBe("analyzing");

    const [session] = await db
      .select()
      .from(workbenchSession)
      .where(eq(workbenchSession.id, body.sessionId))
      .limit(1);

    if (!session) {
      throw new Error("Session not found in database");
    }

    expect(session.status).toBe("analyzing");

    const [transcriptRow] = await db
      .select()
      .from(transcript)
      .where(eq(transcript.id, session.transcriptId))
      .limit(1);

    if (!transcriptRow) {
      throw new Error("Transcript not found in database");
    }

    expect(transcriptRow.content).toBe("Test transcript content");
  });

  it("returns 400 for missing transcript", async () => {
    const response = await app.request("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("transcript is required and must be a string");
  });
});

// Close the database connection after all tests
// Bun:test does not have a global afterAll hook, so we rely on process exit
process.on("exit", () => {
  close();
});
