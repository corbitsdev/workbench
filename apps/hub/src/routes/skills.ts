import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { HubDb } from "../db";
import type { AssetService, RepoStore } from "@workbench/hub-sessions";
import { AssetServiceError } from "@workbench/hub-sessions";
import { getRequestedUserContext } from "../lib/user-context";
import {
  SkillLibraryError,
  approveSkillDraft,
  createSkill,
  discardSkillDraft,
  updateSkill,
  deleteSkill,
  filesFromZip,
  getSkillAsset,
  getSkillContent,
  listShareTargets,
  listSkillDrafts,
  listSkills,
  listSkillVersions,
  restoreSkillVersion,
  type SkillAccessScope,
  type SkillBundleFileInput,
} from "../services/skill-library";

function parseScope(value: unknown): SkillAccessScope {
  return value === "private" ? "private" : "tenant";
}

function errorResponse(c: Context, err: unknown) {
  if (err instanceof SkillLibraryError) {
    const status = err.status as 400 | 403 | 404 | 409 | 413;
    return c.json({ error: err.message }, status);
  }
  throw err;
}

function textFile(name: string, content: string): SkillBundleFileInput {
  return {
    path: name,
    content: Buffer.from(content),
    mimeType: "text/markdown",
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// webkitRelativePath is a DOM-only File property; Bun's File type omits it
// but browser uploads still carry it, so read it structurally.
function fileRelativePath(file: File): string | undefined {
  if ("webkitRelativePath" in file) {
    return readString(file.webkitRelativePath);
  }
  return undefined;
}

function toActor(
  context: { tenantId: string; principalId: string },
  userId: string,
) {
  return {
    tenantId: context.tenantId,
    userId,
    principalId: context.principalId,
  };
}

export function createSkillsRouter(
  db: HubDb,
  assetService: AssetService,
  repoStore: RepoStore,
): Hono<{ Variables: { userId: string; userName: string } }> {
  const router = new Hono<{
    Variables: { userId: string; userName: string };
  }>();

  router.get("/skills", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    const skills = await listSkills(db, {
      tenantId: context.tenantId,
      userId: c.get("userId"),
    });
    return c.json({ skills });
  });

  // Registered before /skills/:assetId so literal path segments are not captured as ids.
  router.get("/skills/share-targets", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    const targets = await listShareTargets(
      db,
      c.get("userId"),
      context.tenantId,
    );
    return c.json({ targets });
  });

  router.get("/skills/drafts", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    try {
      const drafts = await listSkillDrafts(db, repoStore, context);
      return c.json({ drafts }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.get("/skills/:assetId", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    const skill = await getSkillAsset(
      db,
      { tenantId: context.tenantId, userId: c.get("userId") },
      c.req.param("assetId"),
    );
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    const files = await getSkillContent(repoStore, skill.id, skill.name);
    return c.json({ skill, files });
  });

  router.get("/skills/:assetId/versions", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    const skill = await getSkillAsset(
      db,
      { tenantId: context.tenantId, userId: c.get("userId") },
      c.req.param("assetId"),
    );
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    const limit = Number.parseInt(c.req.query("limit") ?? "", 10);
    const offset = Number.parseInt(c.req.query("offset") ?? "", 10);
    const page = await listSkillVersions(repoStore, skill.id, {
      ...(Number.isNaN(limit) ? {} : { limit }),
      ...(Number.isNaN(offset) ? {} : { offset }),
    });
    return c.json(page);
  });

  router.post("/skills/:assetId/restore", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const sha = readString(body.sha)?.trim() ?? "";
      if (!sha) throw new SkillLibraryError("Version sha is required");
      const skill = await restoreSkillVersion(
        assetService,
        db,
        repoStore,
        toActor(context, c.get("userId")),
        c.req.param("assetId"),
        sha,
      );
      return c.json({ skill });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/skills", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);

    try {
      const contentType = c.req.header("content-type") ?? "";
      if (contentType.includes("application/json")) {
        const body = (await c.req.json()) as Record<string, unknown>;
        const name = readString(body.name)?.trim() ?? "";
        const description = readString(body.description) ?? null;
        const text = readString(body.text)?.trim() ?? "";
        const existingAssetId = readString(body.assetId);

        if (existingAssetId) {
          if (!text) throw new SkillLibraryError("Skill text is required");
          const skill = await updateSkill(
            assetService,
            db,
            toActor(context, c.get("userId")),
            {
              assetId: existingAssetId,
              description,
              files: [textFile("SKILL.md", text)],
            },
          );
          return c.json({ skill }, 200);
        }

        if (!name) throw new SkillLibraryError("Skill name is required");
        if (!text) throw new SkillLibraryError("Skill text is required");
        const skill = await createSkill(assetService, db, context, {
          name,
          description,
          files: [textFile("SKILL.md", text)],
          scope: parseScope(body.scope),
          ownerUserId: c.get("userId"),
          ownerName: c.get("userName"),
        });
        return c.json({ skill }, 201);
      }

      const body = await c.req.parseBody({ all: true });
      const name = readString(body.name)?.trim() ?? "";
      const description = readString(body.description) ?? null;
      const existingAssetId = readString(body.assetId);

      const fileValues = body.files ?? body.file;
      const files = Array.isArray(fileValues)
        ? fileValues
        : fileValues
          ? [fileValues]
          : [];
      const pathValues = body.paths;
      const paths = Array.isArray(pathValues)
        ? pathValues.map(String)
        : typeof pathValues === "string"
          ? [pathValues]
          : [];
      const bundleFiles: SkillBundleFileInput[] = [];

      for (const [index, value] of files.entries()) {
        if (!(value instanceof File)) continue;
        const relativePath =
          paths[index] || fileRelativePath(value) || value.name;
        const content = Buffer.from(await value.arrayBuffer());
        if (files.length === 1 && value.name.toLowerCase().endsWith(".zip")) {
          bundleFiles.push(...(await filesFromZip(content)));
        } else {
          bundleFiles.push({
            path: relativePath,
            content,
            mimeType: value.type || "application/octet-stream",
          });
        }
      }

      if (existingAssetId) {
        const skill = await updateSkill(
          assetService,
          db,
          toActor(context, c.get("userId")),
          {
            assetId: existingAssetId,
            description,
            files: bundleFiles,
          },
        );
        return c.json({ skill }, 200);
      }

      if (!name) throw new SkillLibraryError("Skill name is required");
      const skill = await createSkill(assetService, db, context, {
        name,
        description,
        files: bundleFiles,
        scope: parseScope(body.scope),
        ownerUserId: c.get("userId"),
        ownerName: c.get("userName"),
      });
      return c.json({ skill }, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/skills/drafts/:draftId/approve", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    try {
      const draftId = c.req.param("draftId");
      const body = await c.req.json().catch(() => ({}));
      const result = await approveSkillDraft(
        assetService,
        db,
        repoStore,
        context,
        draftId,
        {
          scope: parseScope(body.scope),
          ownerUserId: c.get("userId"),
          ownerName: c.get("userName"),
        },
      );
      return c.json({ skill: result.skill, draftId: result.draftId }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/skills/drafts/:draftId/discard", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    try {
      const draft = await discardSkillDraft(
        db,
        repoStore,
        context,
        c.req.param("draftId"),
      );
      return c.json({ draft }, 200);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.delete("/skills/:assetId", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);
    try {
      await deleteSkill(
        db,
        repoStore,
        toActor(context, c.get("userId")),
        c.req.param("assetId"),
      );
      return c.json({ ok: true });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  router.post("/agents/:agentId/skills/:assetId", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);

    const agentId = c.req.param("agentId");
    const assetId = c.req.param("assetId");

    // Gate on the same visibility rule as reads, so a private skill the caller
    // cannot see can't be attached to (and read through) an agent.
    const skill = await getSkillAsset(
      db,
      { tenantId: context.tenantId, userId: c.get("userId") },
      assetId,
    );
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    try {
      const agentAsset = await assetService.attachAsset({
        agentId,
        assetId,
        ref: "refs/heads/main",
      });
      return c.json({ agentAsset }, 201);
    } catch (err) {
      if (
        err instanceof AssetServiceError &&
        err.reason === "duplicate_attachment"
      ) {
        return c.json({ error: "Skill already attached to this agent" }, 409);
      }
      throw err;
    }
  });

  router.delete("/agents/:agentId/skills/:assetId", async (c) => {
    const { context, forbidden } = await getRequestedUserContext(
      db,
      c.get("userId"),
      c.req.query("tenantId"),
    );
    if (forbidden) return c.json({ error: "Tenant not accessible" }, 403);
    if (!context) return c.json({ error: "User context not found" }, 403);

    const agentId = c.req.param("agentId");
    const assetId = c.req.param("assetId");

    // Gate on the same visibility rule as reads, so a private skill the caller
    // cannot see can't be attached to (and read through) an agent.
    const skill = await getSkillAsset(
      db,
      { tenantId: context.tenantId, userId: c.get("userId") },
      assetId,
    );
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    // AssetService has no detachAsset method; delete the agentAsset row directly.
    const deleted = await db
      .delete(intxSchema.agentAsset)
      .where(
        and(
          eq(intxSchema.agentAsset.agentId, agentId),
          eq(intxSchema.agentAsset.assetId, assetId),
        ),
      )
      .returning();
    if (deleted.length === 0)
      return c.json({ error: "Skill not attached to this agent" }, 404);
    return c.json({ ok: true });
  });

  return router;
}
