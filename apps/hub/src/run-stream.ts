// Live SSE stream of a workflow run's InferenceEvent frames from
// `sidecarRouter.subscribeAgent`. Cutover seam until upstream Interchange
// lands native workflow run streaming (INTR-606).

import { type } from "arktype";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { DB } from "@intx/db";
import { idResource, type RequireGrant, type TenantEnv } from "@intx/hub-api";
import { findRoutableById, type SidecarRouter } from "@intx/hub-sessions";
import { parseInferenceEvent } from "@intx/types/runtime";
import { reportError } from "@corbits/error-sink";

const HEARTBEAT_MS = 5_000;

export function createWorkflowRunStreamRoutes(deps: {
  readonly db: DB["db"];
  readonly sidecarRouter: Pick<SidecarRouter, "subscribeAgent">;
  readonly requireGrant: RequireGrant;
}): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get(
    "/workflows/runs/:runId/stream",
    deps.requireGrant(idResource("workflow-run", "runId"), "read"),
    async (c) => {
      const runId = c.req.param("runId");
      const record = await findRoutableById(deps.db, runId, c.get("tenant").id);
      if (record === undefined) {
        return c.json({ error: { code: "not_found", message: "Run not found" } }, 404);
      }

      c.header("Cache-Control", "no-cache");
      c.header("X-Accel-Buffering", "no");

      return streamSSE(c, async (stream) => {
        const unsubscribe = deps.sidecarRouter.subscribeAgent(record.address, (raw) => {
          const event = parseInferenceEvent(raw);
          if (event instanceof type.errors) return;
          stream.writeSSE({ event: "run", data: JSON.stringify(event) }).catch((err: unknown) => {
            reportError(err, { operation: "hub.runStream.write", extra: { runId } });
          });
        });
        const heartbeat = setInterval(() => {
          stream.writeSSE({ event: "ping", data: "" }).catch((err: unknown) => {
            reportError(err, { operation: "hub.runStream.ping", extra: { runId } });
          });
        }, HEARTBEAT_MS);

        try {
          await new Promise<void>((resolve) => {
            if (c.req.raw.signal.aborted) return resolve();
            c.req.raw.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          clearInterval(heartbeat);
          unsubscribe();
        }
      });
    },
  );

  return app;
}
