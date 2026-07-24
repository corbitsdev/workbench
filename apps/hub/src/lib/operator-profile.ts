import { and, eq } from "drizzle-orm";
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { AGENT_TEMPLATES } from "@workbench/agents";
import { promptFormatForProvider } from "@workbench/prompts";
import {
  buildPersonalAgentSystemPrompt,
  buildPersonalAgentSystemPromptV2,
  myraVariantForTemplateKey,
  OperatorProfileSchema,
  PERSONAL_AGENT_NAME,
  type MemberInstructions,
  type OperatorProfile,
} from "@workbench/myra";
import { memberAgentInstance } from "../db/schema";
import { readMyraVariantPreference } from "../services/myra-variant-preferences";
import type { HubDb } from "../db";

export { promptFormatForProvider };

/**
 * Template keys that are personal agents (kind 'personal') — the structural
 * marker for "this instance gets per-operator personalization", not the
 * display name.
 */
const PERSONAL_TEMPLATE_KEYS = new Set(
  AGENT_TEMPLATES.filter((t) => t.kind === "personal").map((t) => t.key),
);

/**
 * Validate a DB-sourced { name, email } pair into a typed OperatorProfile.
 * `user.name` is free-text set by the member themselves — parsing through the
 * schema at this boundary is what keeps it from ever becoming free-form prose
 * again; renderers downstream (buildPersonalAgentSystemPrompt) only ever see
 * these two known fields, never an arbitrary interpolated string.
 */
export function buildOperatorProfile(user: {
  name: string;
  email: string;
}): OperatorProfile {
  return OperatorProfileSchema.assert({ name: user.name, email: user.email });
}

/**
 * Compose the personal-agent system prompt for a specific launch: provider
 * decides the format, and the operator profile (when known) is appended as an
 * escaped <operator> data section. The shared template is never mutated —
 * this rebuilds it per instance from the versioned builder.
 */
export function personalAgentPromptForLaunch(opts: {
  provider: string;
  operator?: OperatorProfile;
  instructions?: MemberInstructions;
  /**
   * The instance's bound prompt generation and model (from its variant).
   * Rebuilding with a hardcoded generation would silently revert a v2
   * instance to the v1 prompt at every launch (CL-4121). Absent (non-variant
   * personal templates) falls back to the v1 builder, the pre-generations
   * behavior.
   */
  generation?: { key: "v1" | "v2"; model: string };
}): string {
  const format = promptFormatForProvider(opts.provider);
  const options = {
    ...(opts.operator !== undefined ? { operator: opts.operator } : {}),
    ...(opts.instructions !== undefined
      ? { instructions: opts.instructions }
      : {}),
  };
  if (opts.generation?.key === "v2") {
    return buildPersonalAgentSystemPromptV2(PERSONAL_AGENT_NAME, format, {
      ...options,
      model: opts.generation.model,
    });
  }
  return buildPersonalAgentSystemPrompt(PERSONAL_AGENT_NAME, format, options);
}

/**
 * Resolve the member's standing Myra instructions (global + chat surface)
 * for the personalized chat launch prompt. Returns `undefined` when both are
 * unset, distinct from `{}`, so a caller can spread it into
 * `personalAgentPromptForLaunch` without an always-present empty object.
 */
async function resolveChatInstructionsForMember(
  db: DB["db"],
  tenantId: string,
  memberPrincipalId: string,
): Promise<MemberInstructions | undefined> {
  // The workbench preference table lives on the hub schema; this router is
  // handed interchange's DB handle over the same connection. Same seam as
  // myra-threads.ts.
  const hubDb = db as unknown as HubDb;
  const prefs = await readMyraVariantPreference(
    hubDb,
    tenantId,
    memberPrincipalId,
  );
  if (prefs.instructionsGlobal === null && prefs.instructionsChat === null) {
    return undefined;
  }
  return {
    global: prefs.instructionsGlobal,
    surface: prefs.instructionsChat,
  };
}

/** Resolve the operator profile for a member principal (principal → user). */
async function resolveOperatorForMember(
  db: DB["db"],
  memberPrincipalId: string,
): Promise<OperatorProfile | null> {
  const [principal] = await db
    .select({
      kind: intxSchema.principal.kind,
      refId: intxSchema.principal.refId,
    })
    .from(intxSchema.principal)
    .where(eq(intxSchema.principal.id, memberPrincipalId))
    .limit(1);
  if (!principal || principal.kind !== "user") return null;

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
 * (provider-appropriate format + the owning operator's <operator> data
 * section) and return it. Returns null for any non-personal instance, so the
 * caller keeps the agent's own seeded prompt. The single
 * `member_agent_instance` lookup yields both the personal-template check and
 * the owning member.
 */
export async function composePersonalAgentPromptForInstance(
  db: DB["db"],
  opts: { tenantId: string; instanceId: string; provider: string },
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
        eq(memberAgentInstance.instanceId, opts.instanceId),
      ),
    )
    .limit(1);
  if (!mapping || !PERSONAL_TEMPLATE_KEYS.has(mapping.templateKey)) return null;

  const operator = await resolveOperatorForMember(
    db,
    mapping.memberPrincipalId,
  );
  const instructions = await resolveChatInstructionsForMember(
    db,
    opts.tenantId,
    mapping.memberPrincipalId,
  );
  const variant = myraVariantForTemplateKey(mapping.templateKey);
  return personalAgentPromptForLaunch({
    provider: opts.provider,
    ...(operator !== null ? { operator } : {}),
    ...(instructions !== undefined ? { instructions } : {}),
    ...(variant !== null
      ? {
          generation: {
            key: variant.promptGeneration,
            model: variant.model,
          },
        }
      : {}),
  });
}
