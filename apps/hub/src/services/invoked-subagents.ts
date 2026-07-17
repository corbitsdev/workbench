import { and, desc, eq } from "drizzle-orm";
import { generateId } from "@intx/hub-common";
import { INVOKE_TEMPLATE_KEY } from "@workbench/myra";
import type { HubDb } from "../db";
import { memberAgentInstance, memberInvokedSubagent } from "../db/schema";

export type InvokedSubagentRow = {
  mappingId: string;
  agentId: string;
  agentName: string;
  instanceId: string;
  instanceAddress: string;
  sessionId: string | null;
  sessionStatus: string | null;
  lastActivityAt: string;
  firstInvokedAt: string;
  lastInvokedAt: string;
  originConversationId: string | null;
};

/** Member-owned conversation (Myra thread id) for a calling agent instance principal. */
export async function resolveMemberOwnedConversation(
  db: HubDb,
  context: { tenantId: string; principalId: string },
): Promise<{ memberPrincipalId: string; conversationId: string } | null> {
  const instance = await db.query.agentInstance.findFirst({
    where: (i, { and: a, eq: e }) =>
      a(e(i.tenantId, context.tenantId), e(i.principalId, context.principalId)),
  });
  if (!instance) return null;

  const mapping = await db.query.memberAgentInstance.findFirst({
    where: (m, { and: a, eq: e }) =>
      a(e(m.tenantId, context.tenantId), e(m.instanceId, instance.id)),
  });
  if (!mapping) return null;

  return {
    memberPrincipalId: mapping.memberPrincipalId,
    conversationId: mapping.id,
  };
}

export async function recordInvokedSubagentForConversation(args: {
  db: HubDb;
  tenantId: string;
  memberPrincipalId: string;
  originConversationId: string;
  subagentMappingId: string;
}): Promise<void> {
  const now = new Date();
  const existing = await args.db.query.memberInvokedSubagent.findFirst({
    where: (link, { and: a, eq: e }) =>
      a(
        e(link.tenantId, args.tenantId),
        e(link.memberPrincipalId, args.memberPrincipalId),
        e(link.originConversationId, args.originConversationId),
        e(link.subagentMappingId, args.subagentMappingId),
      ),
  });

  if (existing) {
    await args.db
      .update(memberInvokedSubagent)
      .set({ lastInvokedAt: now })
      .where(eq(memberInvokedSubagent.id, existing.id));
    return;
  }

  await args.db.insert(memberInvokedSubagent).values({
    id: generateId("mis"),
    tenantId: args.tenantId,
    memberPrincipalId: args.memberPrincipalId,
    originConversationId: args.originConversationId,
    subagentMappingId: args.subagentMappingId,
    firstInvokedAt: now,
    lastInvokedAt: now,
  });
}

async function rowFromMapping(
  db: HubDb,
  mapping: typeof memberAgentInstance.$inferSelect,
  link: typeof memberInvokedSubagent.$inferSelect | null,
  originConversationId: string | null,
): Promise<InvokedSubagentRow | null> {
  const [agentRow, instanceRow] = await Promise.all([
    db.query.agent.findFirst({
      where: (a, { eq: e }) => e(a.id, mapping.agentId),
    }),
    db.query.agentInstance.findFirst({
      where: (i, { eq: e }) => e(i.id, mapping.instanceId),
    }),
  ]);
  if (!agentRow || !instanceRow) return null;

  let sessionStatus: string | null = null;
  const sessionId = instanceRow.sessionId ?? null;
  if (sessionId) {
    const session = await db.query.agentSession.findFirst({
      where: (s, { eq: e }) => e(s.id, sessionId),
    });
    sessionStatus = session?.status ?? null;
  }

  const firstInvokedAt = (
    link?.firstInvokedAt ?? mapping.createdAt
  ).toISOString();
  const lastInvokedAt = (
    link?.lastInvokedAt ?? mapping.lastActivityAt
  ).toISOString();

  return {
    mappingId: mapping.id,
    agentId: mapping.agentId,
    agentName: agentRow.name,
    instanceId: mapping.instanceId,
    instanceAddress: instanceRow.address,
    sessionId,
    sessionStatus,
    lastActivityAt: mapping.lastActivityAt.toISOString(),
    firstInvokedAt,
    lastInvokedAt,
    originConversationId,
  };
}

export async function listInvokedSubagents(
  db: HubDb,
  args: {
    tenantId: string;
    memberPrincipalId: string;
    originConversationId?: string;
  },
): Promise<InvokedSubagentRow[]> {
  if (args.originConversationId !== undefined) {
    const links = await db
      .select()
      .from(memberInvokedSubagent)
      .where(
        and(
          eq(memberInvokedSubagent.tenantId, args.tenantId),
          eq(memberInvokedSubagent.memberPrincipalId, args.memberPrincipalId),
          eq(
            memberInvokedSubagent.originConversationId,
            args.originConversationId,
          ),
        ),
      )
      .orderBy(desc(memberInvokedSubagent.lastInvokedAt));

    const rows: InvokedSubagentRow[] = [];
    for (const link of links) {
      const mapping = await db.query.memberAgentInstance.findFirst({
        where: (m, { and: a, eq: e }) =>
          a(
            e(m.id, link.subagentMappingId),
            e(m.tenantId, args.tenantId),
            e(m.memberPrincipalId, args.memberPrincipalId),
            e(m.templateKey, INVOKE_TEMPLATE_KEY),
          ),
      });
      if (!mapping) continue;
      const row = await rowFromMapping(
        db,
        mapping,
        link,
        args.originConversationId,
      );
      if (row) rows.push(row);
    }
    return rows;
  }

  const mappings = await db
    .select()
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, args.tenantId),
        eq(memberAgentInstance.memberPrincipalId, args.memberPrincipalId),
        eq(memberAgentInstance.templateKey, INVOKE_TEMPLATE_KEY),
      ),
    )
    .orderBy(desc(memberAgentInstance.lastActivityAt));

  const rows: InvokedSubagentRow[] = [];
  for (const mapping of mappings) {
    const row = await rowFromMapping(db, mapping, null, null);
    if (row) rows.push(row);
  }
  return rows;
}
