import { type } from "arktype";
import { Hono, type Env } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getLogger } from "@intx/log";
import {
  listMyraVariants,
  listStyleAxes,
  MyraVariantSummarySchema,
  StyleAxisSummarySchema,
} from "@workbench/myra";
import {
  MyraVariantPreferencePatchSchema,
  MyraVariantPreferenceSchema,
  readMyraVariantPreference,
  setMyraVariantPreference,
  validateMyraVariantPatch,
} from "../services/myra-variant-preferences";
import type { HubDb } from "../db";

const log = getLogger(["api", "myra-variants"]);

// The tenant group's resolveTenant middleware populates `tenant` and
// `principal` (the caller's member principal in that tenant) — the same
// variables the other /api/tenants/:tenantId/* routers read.
type MyraVariantsEnv = Env & {
  Variables: {
    tenant: { id: string };
    principal: { id: string };
  };
};

const VariantsResponseSchema = type({
  variants: MyraVariantSummarySchema.array(),
});
const StyleAxesResponseSchema = type({
  axes: StyleAxisSummarySchema.array(),
});
const ErrorResponse = type({ error: "string" });

const tenantIdParam = {
  name: "tenantId",
  in: "path" as const,
  required: true,
  description: "Tenant scope.",
  schema: { type: "string" as const },
};

export function createMyraVariantsRouter(db: HubDb): Hono<MyraVariantsEnv> {
  const app = new Hono<MyraVariantsEnv>();

  app.get(
    "/myra/variants",
    describeRoute({
      tags: ["Myra"],
      summary: "List the selectable Myra variants",
      description:
        "The immutable variant catalog from @workbench/myra — chat and triage definitions a member can select as their default, each with its model and cost tier.",
      parameters: [tenantIdParam],
      responses: {
        200: {
          description: "The variant catalog",
          content: {
            "application/json": { schema: resolver(VariantsResponseSchema) },
          },
        },
      },
    }),
    (c) => c.json({ variants: listMyraVariants() }),
  );

  app.get(
    "/myra/style-axes",
    describeRoute({
      tags: ["Myra"],
      summary: "List the personalization style axes",
      description:
        "The immutable style-axes catalog from @workbench/myra — personality, emoji use, UI type, and the artifact/tool/skill usage dials a member can select, each with its options (id/label/description; curated prompt snippets are never shipped to the client).",
      parameters: [tenantIdParam],
      responses: {
        200: {
          description: "The style-axes catalog",
          content: {
            "application/json": { schema: resolver(StyleAxesResponseSchema) },
          },
        },
      },
    }),
    (c) => c.json({ axes: listStyleAxes() }),
  );

  app.get(
    "/members/me/myra-preferences",
    describeRoute({
      tags: ["Myra"],
      summary: "Get the caller's default Myra variant selection",
      description:
        "The caller's chat and triage variant ids, or null on either axis when no selection has been made (canonical default is used).",
      parameters: [tenantIdParam],
      responses: {
        200: {
          description: "The caller's variant selection",
          content: {
            "application/json": {
              schema: resolver(MyraVariantPreferenceSchema),
            },
          },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");
      const prefs = await readMyraVariantPreference(db, tenant.id, principal.id);
      return c.json(prefs);
    },
  );

  app.put(
    "/members/me/myra-preferences",
    describeRoute({
      tags: ["Myra"],
      summary: "Set the caller's default Myra variant selection",
      description:
        "Each provided axis (chat, triage) is set to the given variant id or cleared with null; an omitted axis is left untouched. 400 when a provided id is not a variant of that kind.",
      parameters: [tenantIdParam],
      requestBody: {
        content: {
          "application/json": {
            schema: resolver(MyraVariantPreferencePatchSchema),
          },
        },
      },
      responses: {
        200: {
          description: "The merged selection",
          content: {
            "application/json": {
              schema: resolver(MyraVariantPreferenceSchema),
            },
          },
        },
        400: {
          description: "Invalid body or unknown variant id",
          content: { "application/json": { schema: resolver(ErrorResponse) } },
        },
      },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const principal = c.get("principal");

      const raw = await c.req.json().catch(() => null);
      const patch = MyraVariantPreferencePatchSchema(raw);
      if (patch instanceof type.errors) {
        return c.json({ error: patch.summary }, 400);
      }

      const invalid = validateMyraVariantPatch(patch);
      if (invalid) {
        return c.json({ error: invalid }, 400);
      }

      try {
        const merged = await setMyraVariantPreference(
          db,
          tenant.id,
          principal.id,
          patch,
        );
        return c.json(merged);
      } catch (err) {
        log.error("Failed to persist Myra variant preference", {
          tenantId: tenant.id,
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return c.json({ error: "Failed to persist preference" }, 400);
      }
    },
  );

  return app;
}
