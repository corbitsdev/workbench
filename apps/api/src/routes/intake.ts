import { Hono } from "hono";
import { transcript, workbenchSession } from "../db/schema";
import { GranolaClient } from "../lib/granola";

interface IntakeRequest {
  transcript?: string;
  granolaId?: string;
  source: "paste" | "granola";
}

interface IntakeResponse {
  sessionId: string;
  transcriptId: string;
  status: string;
}

export function createIntakeRouter(db: any): Hono {
  const router = new Hono();

  let granolaClient: GranolaClient | null = null;
  try {
    granolaClient = new GranolaClient();
  } catch {
    // Granola not configured, endpoints will return appropriate errors
  }

  router.post("/intake", async (c) => {
    try {
      const body: IntakeRequest = await c.req.json();

      if (!body.source || !["paste", "granola"].includes(body.source)) {
        return c.json({ error: "Invalid source" }, 400);
      }

      let transcriptContent: string;

      if (body.source === "paste") {
        if (!body.transcript) {
          return c.json({ error: "transcript is required for paste source" }, 400);
        }
        if (body.transcript.trim().length === 0) {
          return c.json({ error: "transcript cannot be empty" }, 400);
        }
        transcriptContent = body.transcript;
      } else if (body.source === "granola") {
        if (!body.granolaId) {
          return c.json({ error: "granolaId is required for granola source" }, 400);
        }
        if (!granolaClient) {
          return c.json({ error: "Granola API not configured" }, 503);
        }
        try {
          const note = await granolaClient.getNoteWithTranscript(body.granolaId);
          transcriptContent = note.transcript || note.title || "";
          if (!transcriptContent) {
            return c.json({ error: "Could not retrieve transcript from Granola" }, 400);
          }
        } catch (error) {
          return c.json({ error: "Failed to fetch from Granola API" }, 400);
        }
      } else {
        return c.json({ error: "Invalid source" }, 400);
      }

      // Create transcript record
      const [transcriptRow] = await db
        .insert(transcript)
        .values({
          content: transcriptContent,
          source: body.source,
        })
        .returning();

      if (!transcriptRow) {
        return c.json({ error: "Failed to create transcript" }, 500);
      }

      // Create session record
      const [sessionRow] = await db
        .insert(workbenchSession)
        .values({
          transcriptId: transcriptRow.id,
          status: "analyzing",
        })
        .returning();

      if (!sessionRow) {
        return c.json({ error: "Failed to create session" }, 500);
      }

      const response: IntakeResponse = {
        sessionId: sessionRow.id,
        transcriptId: transcriptRow.id,
        status: sessionRow.status,
      };

      return c.json(response, 200);
    } catch (error) {
      console.error("Intake error:", error);
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  router.get("/recent-calls", async (c) => {
    try {
      if (!granolaClient) {
        return c.json({ error: "Granola API not configured" }, 503);
      }

      const calls = await (granolaClient as GranolaClient).getRecentNotes(3);
      return c.json({ calls });
    } catch (error) {
      console.error("Recent calls error:", error);
      return c.json({ error: "Failed to fetch recent calls" }, 500);
    }
  });

  return router;
}

export type { IntakeRequest, IntakeResponse };
