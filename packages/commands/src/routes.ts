// The command surface's own HTTP API: listing a tenant's available
// commands (the data the chat-ui autocomplete dropdown needs — never
// the dropdown itself, see the package doc comment in `index.ts`) and
// executing one directly. A workbench message that opens with "/" or a
// command-naming "@" is intercepted earlier, inside
// `@corbits/chat`'s own message route, and never reaches this execute
// endpoint — this route exists for callers that want a command's
// result without posting anything into a workbench's timeline (a
// pre-send preview, a non-chat integration), and for the autocomplete
// listing every such caller shares.
import { Hono } from "hono";
import { type } from "arktype";
import type { TenantEnv } from "@intx/hub-api";
import type { RequireGrant } from "@intx/hub-api";
import { dispatchSlashCommand } from "./dispatch";
import type { CommandListing, CommandRegistry } from "./registry";

export type CreateCommandRoutesDeps = {
  registry: CommandRegistry;
  requireGrant: RequireGrant;
  /**
   * Resolves whether `workbenchId` is a workbench this tenant can see. The
   * execute body carries a free-form workbench id — without this check a
   * principal with a tenant-wide grant could run commands against
   * another tenant's workbench.
   */
  workbenchBelongsToTenant: (
    tenantId: string,
    workbenchId: string,
  ) => Promise<boolean>;
};

const ErrorEnvelope = (code: string, message: string) => ({
  error: { code, message },
});

const ExecuteCommandBody = type({
  name: "string",
  "args?": "string",
  workbenchId: "string",
});

export function createCommandRoutes(
  deps: CreateCommandRoutesDeps,
): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.get(
    "/commands",
    deps.requireGrant("workflow-run:*", "read"),
    async (c) => {
      const tenant = c.get("tenant");
      const commands = await deps.registry.listCommands(tenant.id);
      const items: CommandListing[] = commands.map((command) => {
        const listing = {
          name: command.name,
          description: command.description,
        };
        return command.argumentHint !== undefined
          ? { ...listing, argumentHint: command.argumentHint }
          : listing;
      });
      return c.json({ items });
    },
  );

  app.post(
    "/commands/execute",
    deps.requireGrant("workflow-run:*", "create"),
    async (c) => {
      const body = ExecuteCommandBody(
        await c.req.json().catch(() => undefined),
      );
      if (body instanceof type.errors) {
        return c.json(
          ErrorEnvelope("bad_request", `invalid command body: ${body.summary}`),
          400,
        );
      }

      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const belongs = await deps.workbenchBelongsToTenant(
        tenant.id,
        body.workbenchId,
      );
      if (!belongs) {
        return c.json(ErrorEnvelope("not_found", "workbench not found"), 404);
      }

      const result = await dispatchSlashCommand(
        deps.registry,
        `/${body.name} ${body.args ?? ""}`.trimEnd(),
        {
          tenantId: tenant.id,
          principalId: principal.id,
          workbenchId: body.workbenchId,
        },
      );
      // `dispatchSlashCommand` only returns `undefined` when its input
      // is not slash-shaped, which is unreachable here since the text
      // it is given is always synthesized with a leading "/" above.
      return c.json(result ?? { type: "noop" }, 200);
    },
  );

  return app;
}
