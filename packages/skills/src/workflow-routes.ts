// The sanctioned path for a workflow-process child to reach the skill
// registry, mirroring `/api/workflow-artifacts`: a workflow child has no
// browser session, only its own sidecar bearer token and the run's
// address, so it authenticates through `@corbits/artifacts-hub`'s
// `WorkflowRunAuthenticator` rather than the tenant-session pipeline the
// routes in `./routes.ts` use.
//
// Mounted OUTSIDE the tenant prefix for that reason. Identity NEVER
// rides in a request body: the tenant and principal every read is scoped
// to come from the authenticated run alone, so a model's tool arguments
// can never name a different tenant or a different author's private
// skill.
import { type } from "arktype";
import { Hono } from "hono";

import { SkillRegistryError, type SkillRegistry } from "./registry";

/**
 * The tenant + principal a presented sidecar token and run address
 * resolve to. Declared structurally rather than imported so this package
 * carries no dependency on the artifacts plane; `apps/hub` supplies
 * `@corbits/artifacts-hub`'s `createWorkflowRunAuthenticator`, which is
 * generic over "a sidecar-provisioned caller acting as one resolved
 * run's tenant + principal" and satisfies this shape exactly.
 */
export type WorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(token: string, runAddress: string): Promise<WorkflowRunScope | null>;
};

export type WorkflowSkillsEnv = {
  Variables: { workflowRunScope: WorkflowRunScope };
};

const SearchBody = type({ query: "string" });

const LoadBody = type({ name: "string > 0" });

const CreateBody = type({
  name: "string",
  description: "string",
  body: "string",
});

const UpdateBody = type({
  name: "string",
  body: "string",
  "description?": "string",
});

export type CreateWorkflowSkillRoutesDeps = {
  authenticator: WorkflowRunAuthenticator;
  registry: SkillRegistry;
};

export function createWorkflowSkillRoutes(
  deps: CreateWorkflowSkillRoutesDeps,
): Hono<WorkflowSkillsEnv> {
  const app = new Hono<WorkflowSkillsEnv>();

  app.onError((err, c) => {
    if (err instanceof SkillRegistryError) {
      return c.json(
        { error: { code: err.reason, message: err.message } },
        err.reason === "not_found" ? 404 : 400,
      );
    }
    throw err;
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        {
          error: {
            code: "unauthorized",
            message:
              "Missing or unrecognized sidecar bearer token / run address",
          },
        },
        401,
      );
    }
    c.set("workflowRunScope", scope);
    await next();
  });

  app.get("/list", async (c) => {
    const scope = c.get("workflowRunScope");
    const skills = await deps.registry.list(scope);
    return c.json({
      data: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    });
  });

  app.post("/search", async (c) => {
    const body = SearchBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: body.summary } },
        400,
      );
    }
    const scope = c.get("workflowRunScope");
    const skills = await deps.registry.search(scope, body.query);
    return c.json({
      data: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
      })),
    });
  });

  app.post("/load", async (c) => {
    const body = LoadBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: body.summary } },
        400,
      );
    }
    const scope = c.get("workflowRunScope");
    const skill = await deps.registry.load(scope, body.name);
    return c.json({
      data: {
        name: skill.name,
        description: skill.description,
        body: skill.body,
      },
    });
  });

  // Always `scope: "tenant"` — a skill Myra captures from a workbench
  // conversation is durable know-how for the whole workbench, never a
  // private note only this run's principal can see again.
  app.post("/create", async (c) => {
    const body = CreateBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: body.summary } },
        400,
      );
    }
    const scope = c.get("workflowRunScope");
    const skill = await deps.registry.create(scope, {
      name: body.name,
      description: body.description,
      body: body.body,
      scope: "tenant",
    });
    return c.json({ data: skill });
  });

  // `registry.load` first (404s if the name is unknown) so an update
  // that only wants to change the body can leave the skill's current
  // description exactly as it was, rather than a client having to
  // resend fields it never touched. `registry.update` itself leaves
  // scope untouched — republishing content never changes who can see it.
  app.post("/update", async (c) => {
    const body = UpdateBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        { error: { code: "bad_request", message: body.summary } },
        400,
      );
    }
    const scope = c.get("workflowRunScope");
    const existing = await deps.registry.load(scope, body.name);
    const skill = await deps.registry.update(scope, body.name, {
      description: body.description ?? existing.description,
      body: body.body,
    });
    return c.json({ data: skill });
  });

  return app;
}
