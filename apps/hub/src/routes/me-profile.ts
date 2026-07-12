import { type } from "arktype";
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { ErrorResponse, requestBodySchema } from "../lib/openapi";
import { updateDisplayName, type AuthUserUpdater } from "../lib/display-name";

const ProfilePatchBody = type({ displayName: "1 <= string <= 200" });
const ProfileResponse = type({ userName: "string" });

// Persist the caller's display name (better-auth `user.name`). The value flows
// back through GET /v1/me (`userName`), so the Settings field reflects it on the
// next load. Auth is enforced by the parent `v1` middleware (401 when absent).
export function createMeProfileRouter(
  auth: AuthUserUpdater,
): Hono<{ Variables: { userId: string } }> {
  const app = new Hono<{ Variables: { userId: string } }>();

  app.patch(
    "/me/profile",
    describeRoute({
      tags: ["Me"],
      summary: "Update the caller's display name",
      description:
        "Persists the display name to the caller's identity record (better-auth user.name). Returns the saved value as `userName`.",
      requestBody: {
        content: {
          "application/json": { schema: requestBodySchema(ProfilePatchBody) },
        },
      },
      responses: {
        200: {
          description: "Saved display name",
          content: {
            "application/json": { schema: resolver(ProfileResponse) },
          },
        },
        400: {
          description: "Invalid or empty display name",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const raw = await c.req.json().catch(() => null);
      const parsed = ProfilePatchBody(raw);
      if (parsed instanceof type.errors) {
        return c.json({ error: parsed.summary }, 400);
      }

      const name = parsed.displayName.trim();
      if (!name) {
        return c.json({ error: "Display name cannot be empty" }, 400);
      }

      await updateDisplayName(auth, name, c.req.raw.headers);
      return c.json({ userName: name });
    },
  );

  return app;
}
