// The sanctioned path for a workflow-process child to author, republish, or
// read back a workflow-kind asset, authenticated through
// `WorkflowRunAuthenticator` since a workflow child has no browser session.
// Mounted outside the tenant prefix; identity never rides in the request
// body — tenant and principal always come from the authenticated run.
// Deployment is not here; it goes through the stock deployments route.
import { type } from "arktype";
import { Hono } from "hono";
import { makeErrorEnvelope } from "@corbits/error-sink";

import { WorkflowAuthorError } from "./errors";
import type { WorkflowAuthorRegistry } from "./registry";

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
  "expectedHeadSha?": "string",
});

const DeployPreviewBody = type({
  commitSha: "string",
  entry: "string",
});

function statusFor(reason: WorkflowAuthorError["reason"]): 400 | 403 | 404 | 409 | 502 {
  switch (reason) {
    case "not_found":
      return 404;
    case "forbidden":
      return 403;
    case "conflict":
      return 409;
    case "invalid":
      return 400;
    case "unavailable":
      return 502;
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
      const envelope = makeErrorEnvelope({
        code: err.reason,
        userMessage: err.message,
      });
      return c.json(
        err.currentHeadSha === undefined
          ? envelope
          : { ...envelope, currentHeadSha: err.currentHeadSha },
        statusFor(err.reason),
      );
    }
    throw err;
  });

  app.use("*", async (c, next) => {
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
    const address = c.req.header("x-workflow-run-address") ?? "";
    const scope = await deps.authenticator.resolve(token, address);
    if (scope === null) {
      return c.json(
        makeErrorEnvelope({
          code: "unauthorized",
          userMessage: "Missing or unrecognized sidecar bearer token / run address",
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

  app.get("/:assetId/source", async (c) => {
    const scope = c.get("workflowRunScope");
    const snapshot = await deps.registry.readSource(scope, c.req.param("assetId"));
    return c.json({ data: snapshot });
  });

  // A static read of the already-committed source at `commitSha`. Never
  // calls install/probe/gate/freeze, so it cannot deploy anything.
  app.post("/:assetId/deploy/preview", async (c) => {
    const body = DeployPreviewBody(await c.req.json().catch(() => undefined));
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
    const result = await deps.registry.previewDeploy(scope, c.req.param("assetId"), body);
    return c.json({ data: result });
  });

  return app;
}
