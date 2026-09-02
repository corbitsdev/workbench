// The sanctioned path for a workflow-process child to author, republish,
// or read back a workflow-kind asset, mirroring `@corbits/skills`' own
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
// `POST /:assetId/deploy` (CL-7361) extends this surface to deployment: a
// run-authenticated mirror of the native `/workflows/deployments` route,
// authorized and gated exactly the same way — see `./registry.ts`'s doc
// comment on `deploy`.
import { type } from "arktype";
import { Hono } from "hono";
import { makeErrorEnvelope } from "@workbench/hub-client";

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

const DeployBody = type({
  commitSha: "string",
  entry: "string",
});

const DeployPreviewBody = type({
  commitSha: "string",
  entry: "string",
});

function statusFor(
  reason: WorkflowAuthorError["reason"],
): 400 | 403 | 404 | 409 | 502 {
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

  app.get("/:assetId/source", async (c) => {
    const scope = c.get("workflowRunScope");
    const snapshot = await deps.registry.readSource(
      scope,
      c.req.param("assetId"),
    );
    return c.json({ data: snapshot });
  });

  // CL-7362: a preview of `/:assetId/deploy` — a STATIC read of the
  // already-committed source at `commitSha` (package name, entry, file
  // list, any statically-declared tool pins). Never calls install/probe/
  // gate/freeze, so it cannot deploy anything; a human approves the real
  // `workflow_deploy` call with this committed source already visible.
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
    const result = await deps.registry.previewDeploy(
      scope,
      c.req.param("assetId"),
      body,
    );
    return c.json({ data: result });
  });

  app.post("/:assetId/deploy", async (c) => {
    const body = DeployBody(await c.req.json().catch(() => undefined));
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
    const result = await deps.registry.deploy(
      scope,
      c.req.param("assetId"),
      body,
    );
    return c.json({ data: result }, 201);
  });

  return app;
}
