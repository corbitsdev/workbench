import { Hono } from "hono";
import { type } from "arktype";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import { ScheduleFieldOptionsResponseSchema } from "@workbench/shared";
import type { HubDb } from "../db";
import { getRequestedUserContext } from "../lib/user-context";
import { SCHEDULE_FIELD_OPTIONS_SOURCES } from "../lib/schedule-field-options";

const log = getLogger("hub:schedule-field-options");

const ErrorResponse = type({ error: "string" });

const TENANT_PARAM = {
  name: "tenantId",
  in: "query" as const,
  required: false,
  description: "Target workbench tenant id. Omit for the active workbench.",
  schema: { type: "string" as const },
};

/**
 * Resolves live options for a schedule intake field's `optionsSource` key
 * (CL-4279) — a general mechanism the attach/schedule UI calls instead of the
 * workflow author enumerating values it cannot know statically (a Sumble list
 * id, for example). The `sourceId` names an entry in
 * `SCHEDULE_FIELD_OPTIONS_SOURCES`; the route itself carries no per-provider
 * knowledge.
 */
export function createScheduleFieldOptionsRouter(
  db: HubDb,
): Hono<{ Variables: { userId: string } }> {
  const router = new Hono<{ Variables: { userId: string } }>();

  router.get(
    "/schedule-field-options/:sourceId",
    describeRoute({
      tags: ["Schedule Field Options"],
      summary: "Resolve live options for a schedule intake field",
      description:
        "Resolves the current option list for a schedule intake field whose `optionsSource` names a live source (e.g. a Sumble organization list) rather than static options. Fails with 502 if the source cannot be reached — never returns an empty list to mask a failure.",
      parameters: [
        {
          name: "sourceId",
          in: "path",
          required: true,
          description: "Options-source key from the field's `optionsSource`.",
          schema: { type: "string" },
        },
        TENANT_PARAM,
      ],
      responses: {
        200: {
          description: "Resolved options",
          content: {
            "application/json": {
              schema: resolver(ScheduleFieldOptionsResponseSchema),
            },
          },
        },
        403: {
          description: "Caller is not a member of the requested tenant",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        404: {
          description: "Tenant not found, or sourceId is not registered",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
        502: {
          description: "The live source could not be reached or resolved",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const userId = c.get("userId");
      const { context: userContext, forbidden } = await getRequestedUserContext(
        db,
        userId,
        c.req.query("tenantId"),
      );
      if (forbidden) return c.json({ error: "Forbidden" }, 403);
      if (!userContext) {
        return c.json({ error: "Tenant not found" }, 404);
      }

      const sourceId = c.req.param("sourceId");
      const resolveOptions = SCHEDULE_FIELD_OPTIONS_SOURCES[sourceId];
      if (!resolveOptions) {
        return c.json({ error: `Unknown options source: ${sourceId}` }, 404);
      }

      try {
        const controller = new AbortController();
        const options = await resolveOptions(
          db,
          userContext.tenantId,
          controller.signal,
        );
        return c.json({ options });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Failed to resolve schedule field options", {
          sourceId,
          tenantId: userContext.tenantId,
          error: message,
        });
        return c.json({ error: message }, 502);
      }
    },
  );

  return router;
}
