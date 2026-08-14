// The tenant-scoped registry surface the Skills settings section talks
// to. Mounted under the hub's tenant prefix, so `tenant` and `principal`
// are already resolved by the session middleware; the caller identity
// the registry scopes against comes from that context and never from a
// request body.
import { type } from "arktype";
import { Hono } from "hono";

import type { TenantEnv, RequireGrant } from "@intx/hub-api";

import { skillAccessScopeSchema } from "./access";
import {
  SkillRegistryError,
  type SkillRegistry,
  type SkillRegistryErrorReason,
} from "./registry";

/** Which workflow definitions pin a given skill. */
export type PinnedByResolver = {
  resolve(
    tenantId: string,
    skillName: string,
  ): Promise<
    readonly { readonly definitionId: string; readonly name: string }[]
  >;
};

const CreateDraftBody = type({
  name: "string",
  description: "string",
  body: "string",
});

const PublishDraftBody = type({ scope: skillAccessScopeSchema });

const RestoreBody = type({ commitSha: "string > 0" });

const ScopeBody = type({ scope: skillAccessScopeSchema });

const STATUS_BY_REASON: Record<
  SkillRegistryErrorReason,
  400 | 403 | 404 | 409
> = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
};

function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export type CreateSkillRoutesDeps = {
  registry: SkillRegistry;
  pinnedBy: PinnedByResolver;
  requireGrant: RequireGrant;
};

export function createSkillRoutes({
  registry,
  pinnedBy,
  requireGrant,
}: CreateSkillRoutesDeps): Hono<TenantEnv> {
  const app = new Hono<TenantEnv>();

  app.onError((err, c) => {
    if (err instanceof SkillRegistryError) {
      return c.json(
        errorEnvelope(err.reason, err.message),
        STATUS_BY_REASON[err.reason],
      );
    }
    throw err;
  });

  function caller(c: { get: (key: "tenant" | "principal") => { id: string } }) {
    return {
      tenantId: c.get("tenant").id,
      principalId: c.get("principal").id,
    };
  }

  app.get("/", requireGrant("asset:*", "read"), async (c) => {
    const query = c.req.query("q");
    const skills =
      query === undefined || query.trim() === ""
        ? await registry.list(caller(c))
        : await registry.search(caller(c), query);
    return c.json({ skills });
  });

  app.get("/drafts", requireGrant("asset:*", "read"), async (c) => {
    return c.json({ drafts: await registry.listDrafts(caller(c)) });
  });

  app.post("/drafts", requireGrant("asset:*", "create"), async (c) => {
    const body = CreateDraftBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid skill draft: ${body.summary}`),
        400,
      );
    }
    const draft = await registry.createDraft(caller(c), {
      name: body.name,
      description: body.description,
      body: body.body,
    });
    return c.json({ draft }, 201);
  });

  app.delete("/drafts/:name", requireGrant("asset:*", "create"), async (c) => {
    await registry.discardDraft(caller(c), c.req.param("name"));
    return c.body(null, 204);
  });

  app.post(
    "/drafts/:name/publish",
    requireGrant("asset:*", "create"),
    async (c) => {
      const body = PublishDraftBody(await c.req.json().catch(() => undefined));
      if (body instanceof type.errors) {
        return c.json(
          errorEnvelope("bad_request", `invalid publish: ${body.summary}`),
          400,
        );
      }
      const skill = await registry.publishDraft(
        caller(c),
        c.req.param("name"),
        body.scope,
      );
      return c.json({ skill }, 201);
    },
  );

  app.get("/:name", requireGrant("asset:*", "read"), async (c) => {
    const name = c.req.param("name");
    const scope = caller(c);
    const skill = await registry.load(scope, name);
    return c.json({
      skill,
      pinnedBy: await pinnedBy.resolve(scope.tenantId, name),
    });
  });

  app.get("/:name/versions", requireGrant("asset:*", "read"), async (c) => {
    return c.json({
      versions: await registry.versions(caller(c), c.req.param("name")),
    });
  });

  app.post("/:name/restore", requireGrant("asset:*", "create"), async (c) => {
    const body = RestoreBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid restore: ${body.summary}`),
        400,
      );
    }
    const skill = await registry.restore(
      caller(c),
      c.req.param("name"),
      body.commitSha,
    );
    return c.json({ skill });
  });

  app.put("/:name/scope", requireGrant("asset:*", "create"), async (c) => {
    const body = ScopeBody(await c.req.json().catch(() => undefined));
    if (body instanceof type.errors) {
      return c.json(
        errorEnvelope("bad_request", `invalid scope: ${body.summary}`),
        400,
      );
    }
    const skill = await registry.setScope(
      caller(c),
      c.req.param("name"),
      body.scope,
    );
    return c.json({ skill });
  });

  return app;
}
