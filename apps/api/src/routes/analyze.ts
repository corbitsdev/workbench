import { Hono } from "hono";
import { createDB } from "@intx/db";

export function createAnalyzeHandler(db: ReturnType<typeof createDB>["db"]) {
  const app = new Hono();

  app.post("/analyze", async (c) => {
    return c.json({ sessionId: "todo", painPoints: [], status: "analyzing" });
  });

  return app;
}
