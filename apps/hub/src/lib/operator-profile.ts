import { and, eq } from 'drizzle-orm';
import { schema as intxSchema } from '@intx/db';
import type { DB } from '@intx/db';
import {
  AGENT_TEMPLATES,
  buildPersonalAgentSystemPrompt,
  PERSONAL_AGENT_NAME,
  type PromptFormat,
} from '@workbench/agents';
import { memberAgentInstance } from '../db/schema';

/**
 * Template keys that are personal agents (kind 'personal') — the structural
 * marker for "this instance gets per-operator personalization", not the
 * display name.
 */
const PERSONAL_TEMPLATE_KEYS = new Set(
  AGENT_TEMPLATES.filter((t) => t.kind === 'personal').map((t) => t.key)
);

/**
 * Section format follows the inference provider: Anthropic models are tuned for
 * XML-tagged sections; every other provider (OpenAI / openai-compatible such as
 * DeepSeek) does better with Markdown headings.
 */
export function promptFormatForProvider(provider: string): PromptFormat {
  return { xml: provider === 'anthropic' };
}

/** Terse standing brief naming the operator and pointing Myra at HUMAN.md. */
export function buildOperatorProfile(user: { name: string; email: string }): string {
  return `You work for ${user.name} (${user.email}). Keep HUMAN.md as your standing brief on them — preferences, priorities, open todos — and update it as you learn.`;
}

/**
 * Compose the personal-agent system prompt for a specific launch: provider
 * decides the format, and the operator profile (when known) is appended as an
 * <operator> section. The shared template is never mutated — this rebuilds it
 * per instance from the versioned builder.
 */
export function personalAgentPromptForLaunch(opts: {
  provider: string;
  operatorProfile?: string;
}): string {
  const format = promptFormatForProvider(opts.provider);
  const options =
    opts.operatorProfile !== undefined ? { operatorProfile: opts.operatorProfile } : {};
  return buildPersonalAgentSystemPrompt(PERSONAL_AGENT_NAME, format, options);
}

/** Render the operator profile for a member principal (principal → user). */
async function resolveOperatorForMember(
  db: DB['db'],
  memberPrincipalId: string
): Promise<string | null> {
  const [principal] = await db
    .select({ kind: intxSchema.principal.kind, refId: intxSchema.principal.refId })
    .from(intxSchema.principal)
    .where(eq(intxSchema.principal.id, memberPrincipalId))
    .limit(1);
  if (!principal || principal.kind !== 'user') return null;

  const [userRow] = await db
    .select({ name: intxSchema.user.name, email: intxSchema.user.email })
    .from(intxSchema.user)
    .where(eq(intxSchema.user.id, principal.refId))
    .limit(1);
  if (!userRow) return null;

  return buildOperatorProfile({ name: userRow.name, email: userRow.email });
}

/**
 * If `instanceId` is a personal-agent instance, compose its launch prompt
 * (provider-appropriate format + the owning operator's <operator> section) and
 * return it. Returns null for any non-personal instance, so the caller keeps
 * the agent's own seeded prompt. The single `member_agent_instance` lookup
 * yields both the personal-template check and the owning member.
 */
export async function composePersonalAgentPromptForInstance(
  db: DB['db'],
  opts: { tenantId: string; instanceId: string; provider: string }
): Promise<string | null> {
  const [mapping] = await db
    .select({
      templateKey: memberAgentInstance.templateKey,
      memberPrincipalId: memberAgentInstance.memberPrincipalId,
    })
    .from(memberAgentInstance)
    .where(
      and(
        eq(memberAgentInstance.tenantId, opts.tenantId),
        eq(memberAgentInstance.instanceId, opts.instanceId)
      )
    )
    .limit(1);
  if (!mapping || !PERSONAL_TEMPLATE_KEYS.has(mapping.templateKey)) return null;

  const operatorProfile = await resolveOperatorForMember(db, mapping.memberPrincipalId);
  return personalAgentPromptForLaunch({
    provider: opts.provider,
    ...(operatorProfile !== null ? { operatorProfile } : {}),
  });
}
