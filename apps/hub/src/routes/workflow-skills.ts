import { Hono } from "hono";
import { type } from "arktype";
import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { RepoStore } from "@intx/hub-sessions";
import type { HubDb } from "../db";
import { workflowRunRecord } from "../db/schema";
import { getSkillAsset, getSkillContent } from "../services/skill-library";

const ResolveSkillsBody = type({
  tenantId: "string > 0",
  runId: "string > 0",
  skillIds: "string[]",
});

function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n?/, "").trim();
}

export function createInternalWorkflowSkillsRouter(
  db: HubDb,
  repoStore: RepoStore,
  sidecarToken: string,
): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (c.req.header("Authorization") !== `Bearer ${sidecarToken}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  router.post("/workflow-skills/resolve", async (c) => {
    const parsed = ResolveSkillsBody(await c.req.json().catch(() => ({})));
    if (parsed instanceof type.errors) {
      return c.json({ error: parsed.summary }, 400);
    }

    const run = await db.query.workflowRunRecord.findFirst({
      where: and(
        eq(workflowRunRecord.id, parsed.runId),
        eq(workflowRunRecord.tenantId, parsed.tenantId),
      ),
    });
    if (!run) return c.json({ error: "run not found" }, 404);

    const principal = await db.query.principal.findFirst({
      where: and(
        eq(intxSchema.principal.id, run.principalId),
        eq(intxSchema.principal.tenantId, parsed.tenantId),
        eq(intxSchema.principal.kind, "user"),
        eq(intxSchema.principal.status, "active"),
      ),
    });
    if (!principal?.refId)
      return c.json({ error: "run principal not found" }, 404);

    const requestedIds = [...new Set(parsed.skillIds)];
    const resolved = [];
    const unresolved: string[] = [];
    for (const skillId of requestedIds) {
      const skill = await getSkillAsset(
        db,
        { tenantId: parsed.tenantId, userId: principal.refId },
        skillId,
      );
      if (!skill) {
        unresolved.push(skillId);
        continue;
      }
      const files = await getSkillContent(repoStore, skill.id, skill.name);
      const entrypoint = files.find(
        (file) => file.path === "SKILL.md" && file.content,
      );
      if (!entrypoint?.content) {
        unresolved.push(skillId);
        continue;
      }
      resolved.push({
        id: skill.id,
        name: skill.name,
        displayName: skill.displayName,
        content: stripSkillFrontmatter(entrypoint.content),
      });
    }

    if (unresolved.length > 0)
      return c.json(
        { error: "selected skills could not be resolved", unresolved },
        422,
      );

    return c.json({ skills: resolved });
  });

  return router;
}
