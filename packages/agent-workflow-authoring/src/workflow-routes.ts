// The sanctioned path for a workflow-process child to author or republish
// a workflow-kind asset, mirroring `@corbits/skills`' own
// `createWorkflowSkillRoutes`: a workflow child has no browser session,
// only its sidecar bearer token and the run's address, so it
// authenticates through a `WorkflowRunAuthenticator` rather than the
// tenant-session pipeline a human-facing route would use.
//
// Mounted OUTSIDE the tenant prefix for that reason. Identity NEVER rides
// in a request body: the tenant and principal every write is scoped to
// come from the authenticated run alone, so a model's tool arguments can
// never name a different tenant or write into another principal's
// workflow asset.
//
// This surface stops at "author a workflow asset". Deploying it is
// deliberately out of scope here — see `./registry.ts`'s doc comment.
import { type } from "arktype";
import { Hono } from "hono";
import { makeErrorEnvelope } from "@corbits/error-sink";

import { WorkflowAuthorError, type WorkflowAuthorRegistry } from "./registry";

export type WorkflowRunScope = {
  readonly tenantId: string;
  readonly principalId: string;
};

export type WorkflowRunAuthenticator = {
  resolve(token: string, runAddress: string): Promise<WorkflowRunScope | null>;
};

export type WorkflowAuthoringEnv = {
  Variables: { workflowRunScope: WorkflowRunScope };
};

const FilesInput = type("Record<string, string>");

const AuthorBody = type({
  name: "string",
  files: FilesInput,
  "message?": "string",
});

const RepublishBody = type({
  assetId: "string",
  files: FilesInput,
  "message?": "string",
});

function statusFor(
  reason: WorkflowAuthorError["reason"],
): 400 | 403 | 404 | 409 {
  switch (reason) {
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "invalid":
      return 400;
  }
}

export type CreateWorkflowAuthorRoutesDeps = {
  authenticator: WorkflowRunAuthenticator;
  registry: WorkflowAuthorRegistry;
};

export function createWorkflowAuthorRoutes(
  deps: CreateWorkflowAuthorRoutesDeps,
): Hono<WorkflowAuthoringEnv> {
  const app = new Hono<WorkflowAuthoringEnv>();

  app.onError((err, c) => {
    if (err instanceof WorkflowAuthorError) {
      return c.json(
        makeErrorEnvelope({
          code: err.reason,
          userMessage: err.message,
        }),
        statusFor(err.reason),
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
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage:
            "Missing or unrecognized sidecar bearer token / run address",
        }),
        401,
      );
    }
    c.set("workflowRunScope", scope);
    await next();
  });

  app.post("/author", async (c) => {
    const body = AuthorBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: body.summary,
        }),
        400,
      );
    }
    const scope = c.get("workflowRunScope");
    const summary = await deps.registry.author(scope, body);
    return c.json({ data: summary }, 201);
  });

  app.post("/republish", async (c) => {
    const body = RepublishBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        makeErrorEnvelope({
          code: "bad_request",
          userMessage: body.summary,
        }),
        400,
      );
    }
    const scope = c.get("workflowRunScope");
    const summary = await deps.registry.republish(scope, body.assetId, body);
    return c.json({ data: summary });
  });

  return app;
}
