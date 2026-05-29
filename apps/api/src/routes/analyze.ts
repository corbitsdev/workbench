<<<<<<< cl-787-build-call-selection-and-intake-ui
import { Hono } from "hono";
import { createDB } from "@intx/db";

export function createAnalyzeHandler(db: ReturnType<typeof createDB>["db"]) {
  const app = new Hono();

  app.post("/analyze", async (c) => {
    return c.json({ sessionId: "todo", painPoints: [], status: "analyzing" });
  });

  return app;
=======
import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { DB } from "@intx/db";
import { transcript, workbenchSession } from "../db/schema";
import type { AnalyzeRequest, AnalyzeResponse } from "@gtm/workbench-shared";

export function createAnalyzeHandler(db: DB["db"]) {
  return async (c: Context) => {
    const body = await c.req.json<AnalyzeRequest>();

    if (!body.transcript || typeof body.transcript !== "string") {
      return c.json({ error: "transcript is required and must be a string" }, 400);
    }

    const result = await db.transaction(async (tx) => {
      const [transcriptRow] = await tx
        .insert(transcript)
        .values({
          content: body.transcript,
          source: "paste",
        })
        .returning({ id: transcript.id });

      const [sessionRow] = await tx
        .insert(workbenchSession)
        .values({
          transcriptId: transcriptRow!.id,
          status: "analyzing",
        })
        .returning({ id: workbenchSession.id });

      return { sessionId: sessionRow!.id };
    });

    const response: AnalyzeResponse = {
      sessionId: result.sessionId,
      painPoints: [],
      status: "analyzing",
    };

    return c.json(response, 201);
  };
>>>>>>> main
}
